import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_EMBEDDING_MODEL,
  EMBED_BATCH_SIZE,
  embedOne,
  embeddingsUrl,
  embedTexts,
  embeddingModel,
  isEmbeddingAvailable,
  resetEmbeddingAvailabilityCache,
} from "./ai-embeddings";
import { EMBEDDING_DIMENSIONS } from "./ai-rag";
import type { AiConfig } from "./ai";

const config: AiConfig = {
  enabled: true,
  provider: "arvan",
  model: "gpt-4o-mini",
  baseUrl: "https://ai.example.com/v1/",
  apiKey: "sk-test",
  temperature: 0.3,
};

function embeddingResponse(count: number) {
  return {
    ok: true,
    json: async () => ({
      data: Array.from({ length: count }, (_, index) => ({
        index,
        embedding: new Array(EMBEDDING_DIMENSIONS).fill(0.1),
      })),
      usage: { prompt_tokens: 42 },
    }),
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  resetEmbeddingAvailabilityCache();
  delete process.env.AI_EMBEDDING_MODEL;
});

afterEach(() => {
  delete process.env.AI_EMBEDDING_MODEL;
});

describe("embeddingsUrl", () => {
  it("joins the base URL with /embeddings, tolerating a trailing slash", () => {
    expect(embeddingsUrl("https://ai.example.com/v1/")).toBe("https://ai.example.com/v1/embeddings");
    expect(embeddingsUrl("https://ai.example.com/v1")).toBe("https://ai.example.com/v1/embeddings");
  });
});

describe("embedTexts", () => {
  it("posts the configured model and returns vectors in input order with usage", async () => {
    fetchMock.mockResolvedValueOnce(embeddingResponse(2));
    const batch = await embedTexts(config, ["نان بربری", "کرم مرطوب‌کننده روز"]);
    expect(batch.vectors).toHaveLength(2);
    expect(batch.vectors[0]).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(batch.inputTokens).toBe(42);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://ai.example.com/v1/embeddings");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    expect(JSON.parse(init.body).model).toBe(DEFAULT_EMBEDDING_MODEL);
  });

  it("keeps input order even when the provider orders rows differently", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        // Reversed indices — the zip against the texts must not trust row order.
        data: [1, 0].map((index) => ({
          index,
          embedding: new Array(EMBEDDING_DIMENSIONS).fill(index === 0 ? 0.1 : 0.9),
        })),
        usage: {},
      }),
    });
    const batch = await embedTexts(config, ["اول", "دوم"]);
    // "اول" was index 0 (0.1), "دوم" index 1 (0.9) — despite arriving second.
    expect(batch.vectors[0][0]).toBeCloseTo(0.1);
    expect(batch.vectors[1][0]).toBeCloseTo(0.9);
  });

  it("refuses a vector whose dimensions do not match the schema", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ index: 0, embedding: [0.1, 0.2] }], usage: {} }),
    });
    await expect(embedTexts(config, ["نان"])).rejects.toThrow(/dimension/);
  });

  it("surfaces a provider refusal as an error the caller can degrade from", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => "" });
    await expect(embedTexts(config, ["نان"])).rejects.toThrow("embeddings_http_404");
  });

  it("batches at most EMBED_BATCH_SIZE texts per call", () => {
    expect(EMBED_BATCH_SIZE).toBeGreaterThan(0);
    expect(EMBED_BATCH_SIZE).toBeLessThanOrEqual(100);
  });
});

describe("embeddingModel", () => {
  it("defaults to the model whose dimensions match vector(1536)", () => {
    expect(embeddingModel()).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(DEFAULT_EMBEDDING_MODEL).toBe("text-embedding-3-small");
  });

  it("honours AI_EMBEDDING_MODEL", () => {
    process.env.AI_EMBEDDING_MODEL = "other-embedding";
    expect(embeddingModel()).toBe("other-embedding");
  });
});

describe("isEmbeddingAvailable", () => {
  it("probes once per provider+model and caches the answer", async () => {
    fetchMock.mockResolvedValueOnce(embeddingResponse(1));
    await expect(isEmbeddingAvailable(config)).resolves.toBe(true);
    await expect(isEmbeddingAvailable(config)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("answers false when the provider has no /embeddings", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => "" });
    await expect(isEmbeddingAvailable(config)).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-probes after the cache is reset, and answers false on a network error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await expect(isEmbeddingAvailable(config)).resolves.toBe(false);
    fetchMock.mockResolvedValueOnce(embeddingResponse(1));
    resetEmbeddingAvailabilityCache();
    await expect(isEmbeddingAvailable(config)).resolves.toBe(true);
  });

  it("treats a different model as a different probe", async () => {
    fetchMock.mockResolvedValueOnce(embeddingResponse(1));
    process.env.AI_EMBEDDING_MODEL = "other-embedding";
    await expect(isEmbeddingAvailable(config)).resolves.toBe(true);
    resetEmbeddingAvailabilityCache();
    delete process.env.AI_EMBEDDING_MODEL;
    fetchMock.mockResolvedValueOnce(embeddingResponse(1));
    await expect(isEmbeddingAvailable(config)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("embedOne", () => {
  it("returns the single vector and its tokens", async () => {
    fetchMock.mockResolvedValueOnce(embeddingResponse(1));
    const one = await embedOne(config, "فروش دیروز چقدر بود؟");
    expect(one.vector).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(one.inputTokens).toBe(42);
  });
});
