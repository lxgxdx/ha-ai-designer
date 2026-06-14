/**
 * OpenAI-compatible embedding client — used by the RAG retrieval layer
 * (v0.3.1) to embed user briefs and index wiki articles.
 *
 * Targets the /v1/embeddings endpoint, which OpenAI / MiniMax / Qwen /
 * Ollama (v0.1.32+) / vLLM / LM Studio all expose. Returns one vector
 * per input text.
 *
 * Like llm-client.ts, the apiKey is NEVER logged. baseUrl + model are
 * logged at INFO.
 */
import { loadEmbeddingConfig, EmbeddingConfig } from './ha-client.js';
import { logger } from './logger.js';

export interface EmbedRequest {
  /** Texts to embed. Each must be within the model's token limit
   *  (text-embedding-3-small = 8192 tokens). */
  texts: string[];
  /** Override the model id from config. Mostly for tests. */
  model?: string;
}

export interface EmbedResponse {
  vectors: number[][];
  model: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

export class EmbedError extends Error {
  override readonly name = 'EmbedError';
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

/**
 * Embed a batch of texts using the configured LLM provider's embeddings
 * endpoint. Throws EmbedError if the LLM config has no `embeddingModel`
 * or the upstream returns non-2xx.
 */
export async function embed(req: EmbedRequest): Promise<EmbedResponse> {
  const cfg = loadEmbeddingConfig();
  if (!cfg && !req.model) {
    throw new EmbedError(
      'RAG embedding model not configured. Set llm.embeddingModel in data/config.json.',
      0,
    );
  }
  const effective: EmbeddingConfig = cfg ?? { baseUrl: '', apiKey: '', model: '' };
  const model = req.model ?? effective.model;
  if (!model) {
    throw new EmbedError('RAG embedding model not configured', 0);
  }
  if (!effective.baseUrl) {
    throw new EmbedError(
      'RAG embedding baseUrl not configured. Set llm.embeddingBaseUrl (or llm.baseUrl as fallback) in data/config.json.',
      0,
    );
  }
  const url = `${effective.baseUrl.replace(/\/$/, '')}/embeddings`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (effective.apiKey) {
    headers.Authorization = `Bearer ${effective.apiKey}`;
  }

  logger.info(
    { url, model, count: req.texts.length },
    '→ embedding request',
  );

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ input: req.texts, model }),
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error({ status: res.status, bodyLen: text.length }, '← embedding error');
    throw new EmbedError(
      `Embedding ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
      res.status,
      text,
    );
  }

  // OpenAI shape: { data: [{ embedding: number[] }, ...], model, usage }
  // Some providers (e.g. older Ollama) may return bare arrays — accept both.
  const body = (await res.json()) as {
    data?: { embedding: number[]; index: number }[];
    model?: string;
    usage?: { prompt_tokens?: number; total_tokens?: number };
  } | number[][];

  let vectors: number[][];
  let upstreamModel: string;
  let usage: EmbedResponse['usage'];

  if (Array.isArray(body)) {
    vectors = body;
    upstreamModel = model;
  } else {
    if (!body.data || !Array.isArray(body.data)) {
      throw new EmbedError('embedding response missing data[]', 502, body);
    }
    // Sort by index in case provider returns out-of-order (rare but seen)
    const sorted = [...body.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    vectors = sorted.map((d) => d.embedding);
    upstreamModel = body.model ?? model;
    usage = body.usage;
  }

  if (vectors.length !== req.texts.length) {
    throw new EmbedError(
      `embedding count mismatch: requested ${req.texts.length}, got ${vectors.length}`,
      502,
    );
  }
  if (vectors.some((v) => !Array.isArray(v) || v.length === 0)) {
    throw new EmbedError('embedding returned empty vector', 502);
  }
  // Defensive: verify all vectors share the same dimension (some providers
  // can return mixed dims across a batch when the model is misconfigured).
  const dim = vectors[0]!.length;
  if (vectors.some((v) => v.length !== dim)) {
    throw new EmbedError(
      `embedding dimension mismatch in batch: first=${dim}`,
      502,
    );
  }

  logger.info(
    { model: upstreamModel, dim, usage },
    '← embedding response',
  );
  return { vectors, model: upstreamModel, usage };
}

/**
 * Detect the embedding dimension by sending a tiny probe request.
 * Returns the dimension of the first vector. Used at startup to size
 * the sqlite-vec virtual table.
 */
export async function detectEmbeddingDim(model?: string): Promise<number> {
  const r = await embed({ texts: ['probe'], model });
  return r.vectors[0]!.length;
}
