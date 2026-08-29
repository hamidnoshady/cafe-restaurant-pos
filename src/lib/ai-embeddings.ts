/**
 * Phase 36 Waves 6+7 — the embedding half of RAG and the semantic answer cache.
 *
 * One deliberate decision, from the phase doc's exit criteria: embedding cost
 * appears in `ai_credit_ledger` over the **shared Phase 18 platform
 * connection** — "no second provider connection". So this client talks to the
 * same OpenAI-compatible `{baseUrl}` the chat completions already use, with the
 * same key; only the path (`/embeddings`) and the model differ. The model is
 * `AI_EMBEDDING_MODEL` (default `text-embedding-3-small`, whose 1536
 * dimensions are exactly what migrations 0113/0114's `vector(1536)` columns
 * and `EMBEDDING_DIMENSIONS` expect).
 *
 * A provider that does not offer `/embeddings` (OpenRouter routes chat models,
 * not embedding models) is not an error condition — `isEmbeddingAvailable()`
 * probes once per process and answers false, and both waves degrade to
 * "off", which is precisely pre-Phase-36 behaviour. Callers must treat any
 * throw from `embedTexts` as "off", never as a failed chat turn.
 */
import type { AiConfig } from "./ai";
import { EMBEDDING_DIMENSIONS } from "./ai-rag";

/** Matches `vector(1536)` in migrations 0113/0114. */
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

const EMBED_TIMEOUT_MS = 30_000;
/** The /embeddings API allows batched input; 64 keeps one request small. */
export const EMBED_BATCH_SIZE = 64;

export function embeddingModel(): string {
  return process.env.AI_EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
}

/** Join a base URL with the embeddings path, tolerating a trailing slash. */
export function embeddingsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/embeddings`;
}

export interface EmbeddingBatch {
  vectors: number[][];
  /** Prompt tokens reported by the provider — metered into the turn's usage. */
  inputTokens: number;
}

function parseVector(raw: unknown): number[] {
  if (!Array.isArray(raw)) throw new Error("embeddings_bad_vector");
  const vector = raw.map((value) => Number(value));
  if (vector.some((value) => !Number.isFinite(value))) {
    throw new Error("embeddings_non_finite");
  }
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `embeddings_dimension_mismatch: expected ${EMBEDDING_DIMENSIONS}, received ${vector.length}`,
    );
  }
  return vector;
}

/**
 * Embeds up to `EMBED_BATCH_SIZE` texts in one provider call. Throws on any
 * failure — availability probing and degradation live with the callers, so a
 * hard failure stays loud where it is debugged and silent where it is served.
 */
export async function embedTexts(config: AiConfig, texts: string[]): Promise<EmbeddingBatch> {
  const input = texts.map((text) => text.slice(0, 8000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(embeddingsUrl(config.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ model: embeddingModel(), input }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("embeddings_timeout");
    }
    throw new Error("embeddings_network");
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    await res.text().catch(() => "");
    throw new Error(`embeddings_http_${res.status}`);
  }

  const json = (await res.json().catch(() => null)) as {
    data?: { index?: number; embedding?: unknown }[];
    usage?: { prompt_tokens?: number; total_tokens?: number };
  } | null;
  if (!json || !Array.isArray(json.data) || json.data.length !== input.length) {
    throw new Error("embeddings_bad_response");
  }

  // Providers return rows ordered by `index`; sort defensively before zipping
  // the vectors against the texts that produced them.
  const ordered = [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return {
    vectors: ordered.map((row) => parseVector(row.embedding)),
    inputTokens: Math.max(
      0,
      Math.floor(Number(json.usage?.prompt_tokens ?? json.usage?.total_tokens ?? 0)) || 0,
    ),
  };
}

/** Embeds exactly one text — the question side of both the cache and RAG. */
export async function embedOne(
  config: AiConfig,
  text: string,
): Promise<{ vector: number[]; inputTokens: number }> {
  const batch = await embedTexts(config, [text]);
  return { vector: batch.vectors[0], inputTokens: batch.inputTokens };
}

// ---------------------------------------------------------------------------
// Availability — probed once per process, per provider+model
// ---------------------------------------------------------------------------

const availabilityCache = new Map<string, boolean>();
const availabilityProbe = new Map<string, Promise<boolean>>();

/** Test seam: forget every cached probe result. */
export function resetEmbeddingAvailabilityCache(): void {
  availabilityCache.clear();
  availabilityProbe.clear();
}

function availabilityKey(config: AiConfig): string {
  return `${config.provider}|${config.baseUrl}|${embeddingModel()}`;
}

/**
 * Whether this platform connection can produce embeddings at all: one real
 * one-token probe, cached for the process. Never throws — false is the answer
 * that turns both Wave 6 and Wave 7 off without touching the chat path.
 */
export async function isEmbeddingAvailable(config: AiConfig): Promise<boolean> {
  const key = availabilityKey(config);
  const cached = availabilityCache.get(key);
  if (cached !== undefined) return cached;
  const inFlight = availabilityProbe.get(key);
  if (inFlight) return inFlight;
  const probe = (async () => {
    let ok = false;
    try {
      await embedTexts(config, ["موجودی"]);
      ok = true;
    } catch {
      ok = false;
    } finally {
      availabilityProbe.delete(key);
    }
    availabilityCache.set(key, ok);
    return ok;
  })();
  availabilityProbe.set(key, probe);
  return probe;
}
