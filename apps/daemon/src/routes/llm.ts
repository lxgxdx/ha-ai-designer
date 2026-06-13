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
   * Replace the LLM slice of data/config.json. The body is the full LlmConfig.
   * apiKey is never returned in the response.
   */
  r.post('/api/llm/config', async (req: Request, res: Response) => {
    const body = req.body as Partial<LlmConfig> | undefined;
    if (!body?.provider || !body?.baseUrl || !body?.model) {
      return res.status(400).json({
        ok: false,
        message: 'provider, baseUrl, and model are required (apiKey may be empty for Ollama)',
      });
    }
    if (!/^https?:\/\//.test(body.baseUrl)) {
      return res.status(400).json({ ok: false, message: 'baseUrl must start with http:// or https://' });
    }
    // v0.1.22 SSRF guard: refuse baseUrls that resolve to private/loopback
    // addresses (loopback, RFC1918, link-local incl. cloud metadata, ULA).
    // Dev-only bypass: HA_LLM_ALLOW_PRIVATE_HOSTS=1.
    {
      const v = await ensurePublicBaseUrl('llm.config', body.baseUrl);
      if (!v.ok) {
        return res.status(400).json({
          ok: false,
          code: 'PRIVATE_HOST_BLOCKED',
          message: `baseUrl rejected: ${v.reason}. ` +
            `Set HA_LLM_ALLOW_PRIVATE_HOSTS=1 to allow (development only).`,
        });
      }
    }
    const newLlm: LlmConfig = {
      provider: body.provider,
      baseUrl: body.baseUrl,
      apiKey: body.apiKey ?? '',
      model: body.model,
    };
    try {
      await writeAppConfig({ llm: newLlm });
      logger.info({ provider: newLlm.provider, model: newLlm.model }, 'LLM config updated');
      res.json({ ok: true, llm: maskLlmConfig(newLlm) });
    } catch (e) {
      logger.error({ err: (e as Error).message }, 'failed to write LLM config');
      res.status(500).json({ ok: false, message: (e as Error).message });
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
