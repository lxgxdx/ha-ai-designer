/**
 * OpenAI-compatible chat client.
 *
 * Targets the /chat/completions endpoint, which Anthropic / OpenAI / Qwen /
 * Ollama / vLLM / LM Studio / OpenRouter all expose. Tool calling is
 * supported (the standard `tools: [{type: 'function', function: {...}}]`
 * shape, which Ollama and OpenAI both honor).
 *
 * Stream-mode is supported via SSE. Non-stream mode returns the full
 * completion in one call.
 *
 * The apiKey is NEVER logged. baseUrl + model + intent are logged at
 * INFO for traceability.
 */

import { loadLlmConfig, LlmConfig } from './ha-client.js';
import { logger } from './logger.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** Set for assistant messages that contain tool calls. */
  tool_calls?: ToolCall[];
  /** Required for role: 'tool' messages. */
  tool_call_id?: string;
  /** Optional name for role: 'tool' messages. */
  name?: string;
}

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolDef[];
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
  /** If true, returns a ReadableStream<Uint8Array> of the SSE response. */
  stream?: boolean;
}

export interface ChatResponseChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string | null;
}

export interface ChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatResponseChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatError {
  error: {
    message: string;
    type: string;
    code?: string;
  };
}

export class LlmError extends Error {
  override readonly name = 'LlmError';
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

/**
 * Send a non-streaming chat request. Returns the full response.
 * Throws LlmError on non-2xx.
 */
export async function chat(req: ChatRequest): Promise<ChatResponse> {
  const cfg = loadLlmConfig();
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const headers = buildHeaders(cfg);

  logger.info(
    { url: maskKeyInUrl(url), model: cfg.model, messages: req.messages.length },
    '→ LLM request',
  );

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...req, model: cfg.model, stream: false }),
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error({ status: res.status, bodyLen: text.length }, '← LLM error');
    throw new LlmError(
      `LLM ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
      res.status,
      text,
    );
  }

  const body = (await res.json()) as ChatResponse;
  logger.info(
    {
      model: body.model,
      usage: body.usage,
      finishReason: body.choices?.[0]?.finish_reason,
    },
    '← LLM response',
  );
  return body;
}

/**
 * Send a streaming chat request. Returns the raw ReadableStream of SSE
 * events. Caller is responsible for parsing SSE. We do not log the
 * streamed body to avoid leaking user content.
 */
export async function chatStream(req: ChatRequest): Promise<ReadableStream<Uint8Array>> {
  const cfg = loadLlmConfig();
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const headers = buildHeaders(cfg);

  logger.info(
    { url: maskKeyInUrl(url), model: cfg.model, messages: req.messages.length, stream: true },
    '→ LLM stream',
  );

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...req, model: cfg.model, stream: true }),
  });

  if (!res.ok || !res.body) {
    const text = res.body ? await res.text() : '';
    logger.error({ status: res.status, bodyLen: text.length }, '← LLM stream error');
    throw new LlmError(
      `LLM ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
      res.status,
      text,
    );
  }
  return res.body;
}

function buildHeaders(cfg: LlmConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (cfg.apiKey) {
    headers.Authorization = `Bearer ${cfg.apiKey}`;
  }
  return headers;
}

/** Defensive — never log the URL with the key embedded. */
function maskKeyInUrl(url: string): string {
  return url.replace(/([?&])(api_?key|token)=([^&]+)/gi, '$1$2=***');
}
