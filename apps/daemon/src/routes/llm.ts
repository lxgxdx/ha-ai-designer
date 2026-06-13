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
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { loadConfig, LlmConfig } from '../ha-client.js';
import { chat } from '../llm-client.js';
import { logger } from '../logger.js';

interface AppConfig {
  ha?: { baseUrl: string; token: string };
  llm?: LlmConfig;
}

/**
 * Returns true for IPv4 addresses in private/loopback/link-local/
 * unspecified ranges, including the cloud-metadata address
 * 169.254.169.254 (AWS / GCP / Azure IMDS).
 */
function isPrivateIPv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  // We've validated length === 4 above, so each p[i] is a number under
  // noUncheckedIndexedAccess. Use non-null assertions to keep the type
  // checker happy without disabling the option.
  const [a, b] = p as unknown as [number, number, number, number];
  if (a === 10) return true;                  // 10/8         RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true;    // 192.168/16
  if (a === 127) return true;                 // 127/8        loopback
  if (a === 169 && b === 254) return true;    // 169.254/16   link-local + IMDS
  if (a === 0) return true;                   // 0/8          "this network"
  if (a >= 224) return true;                  // 224/4        multicast + reserved
  return false;
}

/** Returns true for IPv6 loopback / link-local / ULA / multicast / unspecified. */
function isPrivateIPv6(ip: string): boolean {
  // split('%')[0] under noUncheckedIndexedAccess is string | undefined;
  // the array always has at least one element so the non-null assertion
  // is safe.
  const lc = ip.toLowerCase().split('%')[0]!;
  if (lc === '::' || lc === '::1') return true;  // unspecified / loopback
  if (/^fe[89ab][0-9a-f]:/i.test(lc)) return true; // fe80::/10 link-local
  if (/^f[cd]/i.test(lc)) return true;           // fc00::/7     ULA
  if (/^ff/i.test(lc)) return true;              // ff00::/8     multicast
  if (/^2001:db8:/i.test(lc)) return true;       // documentation
  return false;
}

function isPrivateOrLoopbackIP(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateIPv4(ip);
  if (v === 6) return isPrivateIPv6(ip);
  return true;                                   // unknown family → reject
}

/**
 * Validate that `url` points at a publicly routable host. Resolves
 * hostnames via DNS; rejects if ANY resolved address is in a
 * private/loopback/link-local/cloud-metadata range. Catches the
 * common "DNS-rebinding to localhost" attack: if the user supplies
 * a hostname that resolves to 127.0.0.1, 10.x.x.x, 169.254.169.254,
 * etc., we reject the request.
 */
async function validatePublicBaseUrl(url: string): Promise<{ ok: boolean; reason?: string }> {
  let u: URL;
  try { u = new URL(url); } catch { return { ok: false, reason: 'invalid URL' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `unsupported protocol: ${u.protocol}` };
  }
  const host = u.hostname;                        // strips IPv6 brackets
  if (isIP(host)) {
    return isPrivateOrLoopbackIP(host)
      ? { ok: false, reason: `IP ${host} is in a private/loopback/link-local range` }
      : { ok: true };
  }
  let addrs: { address: string; family: number }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch (e) {
    return { ok: false, reason: `DNS resolution failed for ${host}: ${(e as Error).message}` };
  }
  if (addrs.length === 0) {
    return { ok: false, reason: `no DNS records for ${host}` };
  }
  for (const a of addrs) {
    if (isPrivateOrLoopbackIP(a.address)) {
      return {
        ok: false,
        reason: `hostname ${host} resolves to ${a.address} (private/loopback/link-local)`,
      };
    }
  }
  return { ok: true };
}

/** Dev-only bypass for the SSRF guard (e.g. local ollama on 127.0.0.1). */
function isPrivateHostBypassEnabled(): boolean {
  return process.env.HA_LLM_ALLOW_PRIVATE_HOSTS === '1';
}

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
    if (!isPrivateHostBypassEnabled()) {
      const v = await validatePublicBaseUrl(body.baseUrl);
      if (!v.ok) {
        logger.warn({ baseUrl: body.baseUrl, reason: v.reason }, 'llm config rejected: private/loopback host');
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
    if (body.baseUrl && !isPrivateHostBypassEnabled()) {
      const v = await validatePublicBaseUrl(body.baseUrl);
      if (!v.ok) {
        logger.warn({ baseUrl: body.baseUrl, reason: v.reason }, 'llm test override rejected: private/loopback host');
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
