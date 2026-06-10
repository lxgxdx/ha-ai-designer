/**
 * HA client — centralizes Bearer token + base URL + the read/write split.
 *
 * Read operations (GET) execute immediately.
 * Write operations (POST / PUT / DELETE) are gated — callers must pass
 * { confirm: true } explicitly, after which we still log a "→ about to …"
 * line for the user's terminal/scrollback. See `haWrite()`.
 *
 * Token is loaded from data/config.json (gitignored) at first call,
 * then cached for the process lifetime.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { logger } from './logger.js';

interface HaConfig {
  baseUrl: string;
  token: string;
}

/** LLM provider config — BYOK (bring your own key). */
export interface LlmConfig {
  /** Provider id, e.g. "openai" | "anthropic" | "ollama" | "qwen" | "custom". */
  provider: string;
  /** Base URL, e.g. "https://api.openai.com/v1" or "http://localhost:11434/v1". */
  baseUrl: string;
  /** API key. For Ollama, can be empty. Stored as-is, never logged. */
  apiKey: string;
  /** Default model id, e.g. "gpt-4o" or "qwen2.5-coder:32b". */
  model: string;
}

interface AppConfig {
  ha?: HaConfig;
  llm?: LlmConfig;
}

let cachedConfig: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;
  const dataDir = resolve(process.env.HA_DATA_DIR ?? './data');
  const path = join(dataDir, 'config.json');
  if (!existsSync(path)) {
    throw new HaConfigError(
      `Config not found at ${path}. Set it up via the /connect page.`,
    );
  }
  const raw = JSON.parse(readFileSync(path, 'utf8')) as AppConfig;
  cachedConfig = raw;
  return raw;
}

/** Load just the HA slice. Throws if HA isn't configured. */
export function loadHaConfig(): HaConfig {
  const cfg = loadConfig();
  if (!cfg.ha?.baseUrl || !cfg.ha?.token) {
    throw new HaConfigError('data/config.json missing ha.baseUrl or ha.token');
  }
  if (!/^https?:\/\//.test(cfg.ha.baseUrl)) {
    throw new HaConfigError(`Invalid HA baseUrl: ${cfg.ha.baseUrl}`);
  }
  return cfg.ha;
}

/** Load just the LLM slice. Throws if LLM isn't configured. */
export function loadLlmConfig(): LlmConfig {
  const cfg = loadConfig();
  if (!cfg.llm?.baseUrl || !cfg.llm?.model) {
    throw new HaConfigError('LLM not configured. Set it up via the /llm-config page.');
  }
  return cfg.llm;
}

export class HaConfigError extends Error {
  override readonly name = 'HaConfigError';
}

export class HaGatedError extends Error {
  override readonly name = 'HaGatedError';
  readonly code = 'WRITE_NOT_CONFIRMED';
  constructor(message: string) {
    super(message);
  }
}

export interface HaRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Default true. When false, return {status, data} even on non-2xx. */
  throwOnError?: boolean;
  /**
   * Required for any non-GET method. Caller must have obtained user
   * confirmation in the same session. The write is then logged at INFO
   * level so the terminal/scrollback has a clear record of what was sent.
   */
  confirm?: boolean;
  /** Free-form label for the audit log line, e.g. "push dashboard 'kitchen'". */
  intent?: string;
}

export interface HaResponse<T> {
  status: number;
  data: T | null;
}

export async function haRequest<T = unknown>(
  path: string,
  opts: HaRequestOptions = {},
): Promise<HaResponse<T>> {
  const method = opts.method ?? 'GET';

  if (method !== 'GET' && !opts.confirm) {
    throw new HaGatedError(
      `Refused to call ${method} ${path} without explicit { confirm: true }. ` +
        'The user must approve writes in the same session.',
    );
  }

  const cfg = loadHaConfig();
  const url = `${cfg.baseUrl.replace(/\/$/, '')}${path}`;

  // Redact token from any future error messages — log only baseUrl + path.
  if (method !== 'GET') {
    logger.info(
      { intent: opts.intent ?? 'unspecified', method, path },
      '→ HA write — proceeding after user confirmation',
    );
  } else {
    logger.debug({ method, path }, '→ HA read');
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.token}`,
    'Content-Type': 'application/json',
  };

  const res = await fetch(url, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store',
  });

  const data = (res.status === 204
    ? null
    : ((await res.json().catch(() => null)) as T));

  if (opts.throwOnError !== false && !res.ok) {
    throw new Error(
      `HA ${method} ${path} → ${res.status} ${data ? JSON.stringify(data) : ''}`,
    );
  }
  return { status: res.status, data };
}

/** Convenience: clear the cached config. Used by tests and the /connect page. */
export function clearConfigCache(): void {
  cachedConfig = null;
}
