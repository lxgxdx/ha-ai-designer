/**
 * /api/llm/* — LLM BYOK configuration + connectivity test.
 *
 * Writes to data/config.json (gitignored, mode 0600). Never echoes the
 * apiKey in logs or responses (returns a masked version).
 *
 * v0.1.22 SSRF guard: every baseUrl (write or /api/llm/test override)
 * is validated against private/loopback/link-local/cloud-metadata IP
 * ranges. Bypass with HA_LLM_ALLOW_PRIVATE_HOSTS=1 (development only).
 */

import type { Request, Response, Router } from 'express';
import express from 'express';
import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { loadConfig, LlmConfig } from '../ha-client.js';
import { chat } from '../llm-client.js';
import { logger } from '../logger.js';
import { ensurePublicBaseUrl, isPrivateHostBypassEnabled } from '../url-safety.js';

interface AppConfig {
  ha?: { baseUrl: string; token: string };
  llm?: LlmConfig;
}

/**
 * v0.2.0: SSRF guard helpers (validatePublicBaseUrl, ensurePublicBaseUrl,
 * isPrivateHostBypassEnabled, IP-range predicates) are factored out
 * into ./url-safety.js so the same guard can protect /api/ha/config
 * (which forwards a Bearer HA token to a user-supplied baseUrl) and
 * any future user-supplied URL endpoint.
 */

const KNOWN_PROVIDERS: Record<string, { baseUrl: string; defaultModel: string }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o' },
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', defaultModel: 'claude-3-5-sonnet-latest' },
  qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-plus' },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4-plus' },
  moonshot: { baseUrl: 'https://api.moonshot.cn/v1', defaultModel: 'moonshot-v1-32k' },
  ollama: { baseUrl: 'http://localhost:11434/v1', defaultModel: 'qwen2.5-coder:32b' },
  // MiniMax platform — OpenAI-compatible chat/completions endpoint
  // and an Anthropic-compatible path. Default model is the M-series
  // multimodal "m3" the user picked. Update if the actual model id differs.
  minimax: { baseUrl: 'https://api.minimaxi.com/v1', defaultModel: 'MiniMax-Text-01' },
  custom: { baseUrl: '', defaultModel: '' },
};

export function createLlmRouter(): Router {
  const r = express.Router();
  r.use(express.json({ limit: '32kb' }));

  /**
   * GET /api/llm/config
   * Returns the current LLM config with apiKey masked.
   * If not configured, returns { configured: false }.
   */
  r.get('/api/llm/config', async (_req: Request, res: Response) => {
    try {
      const cfg = loadConfig();
      if (!cfg.llm) {
        return res.json({ configured: false });
      }
      res.json({ configured: true, llm: maskLlmConfig(cfg.llm) });
    } catch (e) {
      if ((e as Error).name === 'HaConfigError') {
        return res.json({ configured: false });
      }
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /**
   * GET /api/llm/providers
   * Returns the catalog of known providers (for the UI form).
   */
  r.get('/api/llm/providers', (_req: Request, res: Response) => {
    res.json({
      providers: Object.entries(KNOWN_PROVIDERS).map(([id, v]) => ({
        id,
        baseUrl: v.baseUrl,
        defaultModel: v.defaultModel,
      })),
    });
  });

  /**
   * POST /api/llm/config
   * v0.4.0: PATCH semantics — only the fields provided in the body
   * are written; existing fields are preserved. This lets the
   * /setup wizard update embedding settings in step 3 without
   * wiping the chat LLM settings saved in step 2.
   *
   * Body semantics (per field):
   *   - key absent OR `undefined`: keep existing
   *   - key = `null` OR `""`:     clear the field
   *   - key = string:             set to that value
   *
   * Validation:
   *   - When chat fields are touched (provider / baseUrl / apiKey /
   *     model), all 4 must be present and baseUrl must pass SSRF
   *     guard. apiKey can be empty (Ollama).
   *   - When ONLY embedding fields are touched, chat fields are not
   *     required (RAG-only deployment).
   *   - At least one field must result in a non-empty config (chat
   *     OR embedding). Otherwise 400.
   */
  r.post('/api/llm/config', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    // Read existing llm to support partial updates.
    let existingLlm: Partial<LlmConfig> = {};
    try {
      const cfg = loadConfig();
      if (cfg.llm) existingLlm = cfg.llm;
    } catch { /* no existing — first-time setup */ }

    const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(body, k);
    const isUnset = (v: unknown): boolean => v === null || v === undefined;
    const pick = (k: string, fallback: string | undefined): string | undefined => {
      if (!has(k)) return fallback;
      const v = body[k];
      if (isUnset(v) || v === '') return undefined;
      return String(v);
    };

    // Chat fields: resolve from body or existing
    const isTouchingChat = has('provider') || has('baseUrl') || has('apiKey') || has('model');
    let newProvider = pick('provider', existingLlm.provider);
    let newBaseUrl  = pick('baseUrl',  existingLlm.baseUrl);
    let newApiKey   = pick('apiKey',   existingLlm.apiKey) ?? '';
    let newModel    = pick('model',    existingLlm.model);

    if (isTouchingChat) {
      if (!newProvider || !newBaseUrl || !newModel) {
        return res.status(400).json({
          ok: false,
          message: 'provider, baseUrl, and model are required when updating chat (apiKey may be empty for Ollama)',
        });
      }
      if (!/^https?:\/\//.test(newBaseUrl)) {
        return res.status(400).json({ ok: false, message: 'baseUrl must start with http:// or https://' });
      }
      // v0.1.22 SSRF guard
      const v = await ensurePublicBaseUrl('llm.config', newBaseUrl);
      if (!v.ok) {
        return res.status(400).json({
          ok: false,
          code: 'PRIVATE_HOST_BLOCKED',
          message: `baseUrl rejected: ${v.reason}. ` +
            `Set HA_LLM_ALLOW_PRIVATE_HOSTS=1 to allow (development only).`,
        });
      }
    }

    // Embedding fields: apply with the unset / null / value semantics
    const newLlm: Partial<LlmConfig> = { ...existingLlm };
    if (isTouchingChat) {
      newLlm.provider = newProvider!;
      newLlm.baseUrl = newBaseUrl!;
      newLlm.apiKey = newApiKey;
      newLlm.model = newModel!;
    }
    for (const key of ['embeddingModel', 'embeddingBaseUrl', 'embeddingApiKey'] as const) {
      if (has(key)) {
        const v = body[key];
        if (isUnset(v) || v === '') {
          delete newLlm[key];
        } else {
          newLlm[key] = String(v);
        }
      }
    }

    // Require at least chat OR embedding to be set
    if (!newLlm.provider && !newLlm.embeddingModel) {
      return res.status(400).json({
        ok: false,
        message: 'Either chat (provider+baseUrl+model) or embedding (embeddingModel) must be set',
      });
    }

    // Build the full LlmConfig that we'll persist. writeAppConfig
    // expects a complete LlmConfig (not partial) — fill missing
    // required fields with empty strings so the saved file is
    // well-formed. The chat LLM may not be configured at all (RAG-
    // only), in which case provider/baseUrl/apiKey/model are all ''.
    const persisted: LlmConfig = {
      provider: newLlm.provider ?? '',
      baseUrl: newLlm.baseUrl ?? '',
      apiKey: newLlm.apiKey ?? '',
      model: newLlm.model ?? '',
    };
    if (newLlm.embeddingModel) persisted.embeddingModel = newLlm.embeddingModel;
    if (newLlm.embeddingBaseUrl) persisted.embeddingBaseUrl = newLlm.embeddingBaseUrl;
    if (newLlm.embeddingApiKey) persisted.embeddingApiKey = newLlm.embeddingApiKey;

    try {
      await writeAppConfig({ llm: persisted });
      logger.info({
        provider: persisted.provider || '<unset>',
        model: persisted.model || '<unset>',
        embedding: persisted.embeddingModel ? 'configured' : 'cleared',
      }, 'LLM config updated');
      res.json({ ok: true, llm: maskLlmConfig(persisted) });
    } catch (e) {
      logger.error({ err: (e as Error).message }, 'failed to write LLM config');
      res.status(500).json({ ok: false, message: (e as Error).message });
    }
  });

  /**
   * v0.4.0: POST /api/llm/test-embedding
   * Probe the embedding endpoint with a tiny `["probe"]` input and
   * return the response vector dimension + latency. Used by the
   * /setup wizard step 3 "Test" button to verify the embedding
   * configuration before the user moves on.
   *
   * Body semantics mirror /api/llm/test:
   *   - body.baseUrl / body.apiKey / body.model (all optional): override
   *     saved config. When provided, the probe uses them.
   *   - empty body or partial body: use saved config. Falls back to
   *     llm.embeddingModel / llm.embeddingBaseUrl ?? llm.baseUrl /
   *     llm.embeddingApiKey ?? llm.apiKey.
   *
   * Returns: { ok: true, dim, latencyMs, model } on success.
   *          { ok: false, code, message } on failure.
   */
  r.post('/api/llm/test-embedding', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { baseUrl?: string; apiKey?: string; model?: string };

    if (body.baseUrl) {
      const v = await ensurePublicBaseUrl('llm.test-embedding', body.baseUrl);
      if (!v.ok) {
        return res.status(400).json({
          ok: false,
          code: 'PRIVATE_HOST_BLOCKED',
          message: `baseUrl rejected: ${v.reason}. ` +
            `Set HA_LLM_ALLOW_PRIVATE_HOSTS=1 to allow (development only).`,
        });
      }
    }

    // Resolve the test config: override → saved
    let testBaseUrl = body.baseUrl;
    let testApiKey  = body.apiKey;
    let testModel   = body.model;
    if (!testBaseUrl || !testModel) {
      try {
        const cfg = loadConfig();
        if (!cfg.llm) {
          return res.status(400).json({
            ok: false,
            message: 'No saved config — pass baseUrl + model in the body',
          });
        }
        testBaseUrl = testBaseUrl ?? cfg.llm.embeddingBaseUrl ?? cfg.llm.baseUrl ?? '';
        testApiKey  = testApiKey  ?? cfg.llm.embeddingApiKey  ?? cfg.llm.apiKey  ?? '';
        testModel   = testModel   ?? cfg.llm.embeddingModel   ?? '';
      } catch {
        return res.status(400).json({
          ok: false,
          message: 'No saved config — pass baseUrl + model in the body',
        });
      }
    }

    if (!testBaseUrl || !testModel) {
      return res.status(400).json({
        ok: false,
        message: 'embedding baseUrl and model are required (either in body or in saved config)',
      });
    }

    // Tiny probe: a single short string. Some providers (Ollama before
    // 0.1.32) reject empty inputs, so always pass at least one token.
    const url = `${testBaseUrl.replace(/\/$/, '')}/embeddings`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (testApiKey) headers.Authorization = `Bearer ${testApiKey}`;

    const t0 = Date.now();
    try {
      const r2 = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ input: ['probe'], model: testModel }),
      });
      const latencyMs = Date.now() - t0;
      if (!r2.ok) {
        const text = await r2.text();
        return res.status(502).json({
          ok: false,
          message: `Embedding ${r2.status} ${r2.statusText}: ${text.slice(0, 300)}`,
        });
      }
      const respBody = (await r2.json()) as {
        data?: { embedding: number[]; index?: number }[];
        model?: string;
      } | number[][];

      let dim = 0;
      let upstreamModel = testModel;
      if (Array.isArray(respBody)) {
        dim = respBody[0]?.length ?? 0;
      } else if (respBody.data?.[0]?.embedding) {
        dim = respBody.data[0].embedding.length;
        upstreamModel = respBody.model ?? testModel;
      }
      if (dim === 0) {
        return res.status(502).json({
          ok: false,
          message: 'embedding response missing data[0].embedding',
        });
      }
      res.json({ ok: true, dim, latencyMs, model: upstreamModel });
    } catch (e) {
      res.status(502).json({ ok: false, message: (e as Error).message });
    }
  });

  /**
   * POST /api/llm/test
   * Send a minimal "hello" chat to verify the BYOK works. Echoes back
   * the assistant's reply (short) and the latency. Does NOT save config.
   */
  r.post('/api/llm/test', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { baseUrl?: string; apiKey?: string; model?: string };
    // v0.1.22 SSRF guard: validate the override baseUrl (if any) before
    // using it for the test call. Without this an authenticated user could
    // /api/llm/test { baseUrl: "http://169.254.169.254/..." } and probe
    // cloud metadata even when a perfectly valid LLM is configured.
    if (body.baseUrl) {
      const v = await ensurePublicBaseUrl('llm.test', body.baseUrl);
      if (!v.ok) {
        return res.status(400).json({
          ok: false,
          code: 'PRIVATE_HOST_BLOCKED',
          message: `baseUrl rejected: ${v.reason}. ` +
            `Set HA_LLM_ALLOW_PRIVATE_HOSTS=1 to allow (development only).`,
        });
      }
    }
    if (body.baseUrl || body.apiKey || body.model) {
      // Override path — test before saving. Build a transient config.
      try {
        const cfg = loadConfig();
        const testCfg: LlmConfig = {
          provider: 'test',
          baseUrl: body.baseUrl ?? cfg.llm?.baseUrl ?? '',
          apiKey: body.apiKey ?? cfg.llm?.apiKey ?? '',
          model: body.model ?? cfg.llm?.model ?? '',
        };
        const reply = await testChat(testCfg);
        res.json({ ok: true, ...reply });
      } catch (e) {
        res.status(502).json({ ok: false, message: (e as Error).message });
      }
      return;
    }
    // Test the saved config
    try {
      const cfg = loadConfig();
      if (!cfg.llm) {
        return res.status(400).json({ ok: false, message: 'No LLM configured' });
      }
      const reply = await testChat(cfg.llm);
      res.json({ ok: true, ...reply });
    } catch (e) {
      res.status(502).json({ ok: false, message: (e as Error).message });
    }
  });

  return r;
}

interface TestResult {
  latencyMs: number;
  model: string;
  reply: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

async function testChat(cfg: LlmConfig): Promise<TestResult> {
  // We can't use the shared `chat()` because it reads from disk via loadLlmConfig.
  // For the override path, call fetch directly with the transient cfg.
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'user', content: 'Reply with just "ok" and nothing else.' }],
      max_tokens: 8,
      temperature: 0,
    }),
  });
  const latencyMs = Date.now() - t0;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }
  const body = (await res.json()) as {
    model: string;
    choices?: { message?: { content?: string } }[];
    usage?: TestResult['usage'];
  };
  return {
    latencyMs,
    model: body.model,
    reply: body.choices?.[0]?.message?.content?.trim() ?? '',
    usage: body.usage,
  };
}

function maskLlmConfig(cfg: LlmConfig): LlmConfig & { apiKeyMasked: string; apiKeySet: boolean } {
  const set = cfg.apiKey.length > 0;
  return {
    ...cfg,
    apiKey: set ? maskKey(cfg.apiKey) : '',
    apiKeyMasked: set ? maskKey(cfg.apiKey) : '',
    apiKeySet: set,
  };
}

function maskKey(k: string): string {
  if (k.length <= 8) return '***';
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

function readAppConfig(): AppConfig {
  const dataDir = resolve(process.env.HA_DATA_DIR ?? './data');
  const path = join(dataDir, 'config.json');
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as AppConfig;
  } catch {
    return {};
  }
}

async function writeAppConfig(updates: Partial<AppConfig>): Promise<void> {
  const fs = await import('node:fs/promises');
  const dataDir = resolve(process.env.HA_DATA_DIR ?? './data');
  const path = join(dataDir, 'config.json');
  await fs.mkdir(dataDir, { recursive: true });
  const current = readAppConfig();
  const next = { ...current, ...updates };
  await fs.writeFile(path, JSON.stringify(next, null, 2), { mode: 0o600 });
  // Clear the cached config so subsequent reads pick up the changes.
  // We import here to avoid a circular dep.
  const { clearConfigCache } = await import('../ha-client.js');
  clearConfigCache();
}
