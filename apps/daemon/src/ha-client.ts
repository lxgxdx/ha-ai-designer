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
  /** Default chat model id, e.g. "gpt-4o" or "qwen2.5-coder:32b". */
  model: string;
  /**
   * v0.3.1 (RAG): embedding model id for the RAG retrieval layer.
   * Optional — when unset, RAG is disabled. The embedding endpoint is
   * assumed to live at the same baseUrl under `/v1/embeddings` (the
   * OpenAI-compat shape, which MiniMax / OpenAI / Qwen / Ollama all
   * expose). Recommended values: `text-embedding-3-small` (1536d,
   * OpenAI) or whatever the BYOK provider documents.
   */
  embeddingModel?: string;
  /**
   * v0.3.1.1: optional override for the embedding endpoint baseUrl.
   * Useful when the chat and embedding providers differ — e.g. chat
   * via MiniMax, embeddings via a local `infinity` server running
   * BAAI/bge-m3. Falls back to `baseUrl` when unset.
   */
  embeddingBaseUrl?: string;
  /**
   * v0.3.1.1: optional apiKey for the embedding endpoint, used only
   * when `embeddingBaseUrl` is set. Falls back to `apiKey` when unset.
   * Most local embedding servers (infinity / Ollama / vLLM / LM Studio)
   * don't require a key.
   */
  embeddingApiKey?: string;
}

/**
 * v0.3.1.1: independent embedding config loader. RAG-only — does NOT
 * require the chat LLM (provider/baseUrl/apiKey/model) to be set.
 * Returns null if no embeddingModel is configured (RAG disabled).
 *
 * Resolution order for each field:
 *   - model:    `llm.embeddingModel` (required for RAG)
 *   - baseUrl:  `llm.embeddingBaseUrl` ?? `llm.baseUrl` ?? ''
 *   - apiKey:   `llm.embeddingApiKey` ?? `llm.apiKey` ?? ''
 *
 * The fallback chain means:
 *   - If the user configures ONLY the chat LLM and uses a provider
 *     that also serves /v1/embeddings (e.g. OpenAI, MiniMax), the
 *     chat baseUrl is reused.
 *   - If the user configures ONLY the embedding (e.g. local infinity
 *     + bge-m3, no chat LLM in the picture), the chat fields can be
 *     left blank in config.json — loadLlmConfig() will still throw on
 *     /api/chat, but the RAG store will index just fine.
 */
export interface EmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function loadEmbeddingConfig(): EmbeddingConfig | null {
  const cfg = loadConfig();
  const model = cfg.llm?.embeddingModel;
  if (!model) return null;
  return {
    baseUrl: cfg.llm?.embeddingBaseUrl ?? cfg.llm?.baseUrl ?? '',
    apiKey: cfg.llm?.embeddingApiKey ?? cfg.llm?.apiKey ?? '',
    model,
  };
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
