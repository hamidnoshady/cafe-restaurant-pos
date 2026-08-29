import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ query: vi.fn() }));

vi.mock("./ai-rag", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ai-rag")>();
  return {
    ...actual,
    isRetrievalAvailable: vi.fn(),
    upsertEmbedding: vi.fn(),
  };
});

vi.mock("./ai-embeddings", () => ({
  embedTexts: vi.fn(),
  isEmbeddingAvailable: vi.fn(),
  EMBED_BATCH_SIZE: 64,
}));

import { query } from "./db";
import { isRetrievalAvailable, upsertEmbedding } from "./ai-rag";
import { embedTexts, isEmbeddingAvailable } from "./ai-embeddings";
import { reindexBusinessKnowledge, DEFAULT_MAX_CHUNKS } from "./ai-rag-indexer";
import type { AiConfig } from "./ai";

const mockQuery = vi.mocked(query);
const mockRetrieval = vi.mocked(isRetrievalAvailable);
const mockEmbedAvailable = vi.mocked(isEmbeddingAvailable);
const mockEmbedTexts = vi.mocked(embedTexts);
const mockUpsert = vi.mocked(upsertEmbedding);

const config: AiConfig = {
  enabled: true,
  provider: "arvan",
  model: "gpt-4o-mini",
  baseUrl: "https://ai.example.com/v1",
  apiKey: "sk-test",
  temperature: 0.3,
};

/** Routes a mocked query by a distinctive fragment of its SQL. */
function routeQuery(routes: Array<[fragment: string, rows: unknown[]]>): void {
  mockQuery.mockImplementation((async (sql: string) => {
    for (const [fragment, rows] of routes) {
      if (String(sql).includes(fragment)) return { rows };
    }
    return { rows: [] };
  }) as never);
}

function vector(): number[] {
  return new Array(1536).fill(0.1);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockUpsert.mockReset().mockResolvedValue(true);
  mockEmbedTexts.mockReset().mockResolvedValue({ vectors: [], inputTokens: 0 });
  mockRetrieval.mockReset().mockResolvedValue(true);
  mockEmbedAvailable.mockReset().mockResolvedValue(true);
});

describe("availability", () => {
  it("touches nothing when pgvector or the 0113 table is absent", async () => {
    mockRetrieval.mockResolvedValue(false);
    const report = await reindexBusinessKnowledge("b1", config);
    expect(report).toMatchObject({ retrieval: false, embedded: 0, deleted: 0 });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockEmbedTexts).not.toHaveBeenCalled();
  });

  it("touches nothing when the platform connection cannot embed", async () => {
    mockEmbedAvailable.mockResolvedValue(false);
    const report = await reindexBusinessKnowledge("b1", config);
    expect(report.retrieval).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("reindexBusinessKnowledge", () => {
  it("embeds every collected kind and names its source", async () => {
    routeQuery([
      ["FROM menu_items mi", [{ ref_id: "m1", name: "نان بربری", description: "با کره", ts: null }]],
      ["FROM inventory_items ii", [{ ref_id: "i1", name: "آرد", unit: "kg" }]],
      ["FROM customers WHERE", [{ ref_id: "c1", name: "زهرا" }]],
      ["FROM ai_project_notes n", [{ ref_id: "n1", project: "شعبه دوم", title: "یادداشت", content: "متن", ts: null }]],
    ]);
    mockEmbedTexts.mockImplementation(async (cfg: AiConfig, texts: string[]) => ({
      vectors: texts.map(() => vector()),
      inputTokens: 10 * texts.length,
    }));

    const report = await reindexBusinessKnowledge("b1", config);

    expect(report.retrieval).toBe(true);
    expect(report.embedded).toBe(4);
    // The embedded content is prose the model can be shown, and never a figure.
    const embeddedTexts = mockEmbedTexts.mock.calls.flatMap((call) => call[1]);
    expect(embeddedTexts).toContain("نان بربری — با کره");
    expect(embeddedTexts).toContain("آرد (واحد: kg)");
    expect(embeddedTexts).toContain("زهرا");
    expect(embeddedTexts).toContain("یادداشت — متن");
    // One upsert per chunk, carrying its kind and label.
    expect(mockUpsert).toHaveBeenCalledTimes(4);
    const kinds = mockUpsert.mock.calls.map((call) => call[1].kind);
    expect(new Set(kinds)).toEqual(new Set(["menu_item", "item", "customer", "project_note"]));
  });

  it("drops vectors whose source row disappeared, for kinds seen in full", async () => {
    routeQuery([
      ["FROM menu_items mi", [{ ref_id: "m1", name: "نان", description: null, ts: null }]],
      ["FROM inventory_items ii", []],
      ["FROM customers WHERE", []],
      ["FROM ai_project_notes n", []],
    ]);
    mockEmbedTexts.mockResolvedValue({ vectors: [vector()], inputTokens: 1 });
    mockQuery.mockImplementation((async (sql: string) => {
      if (String(sql).includes("FROM menu_items mi")) {
        return { rows: [{ ref_id: "m1", name: "نان", description: null, ts: null }] };
      }
      if (String(sql).includes("DELETE FROM ai_embeddings")) {
        return { rowCount: 3 };
      }
      return { rows: [] };
    }) as never);

    const report = await reindexBusinessKnowledge("b1", config);
    expect(report.deleted).toBe(3);
    const deleteSql = mockQuery.mock.calls.map((call) => String(call[0])).find((sql) =>
      sql.includes("DELETE FROM ai_embeddings"),
    );
    expect(deleteSql).toContain("kind = $2");
    expect(deleteSql).toContain("NOT (ref_id = ANY($3::text[]))");
  });

  it("never deletes from a truncated kind — a partial id list would nuke good rows", async () => {
    const many = Array.from({ length: 260 }, (_, i) => ({ ref_id: `m${i}`, name: `آیتم ${i}`, description: null }));
    mockQuery.mockImplementation((async (sql: string) => {
      if (String(sql).includes("FROM menu_items mi")) return { rows: many };
      return { rows: [] };
    }) as never);
    mockEmbedTexts.mockImplementation(async (_cfg: AiConfig, texts: string[]) => ({
      vectors: texts.map(() => vector()),
      inputTokens: 0,
    }));

    const report = await reindexBusinessKnowledge("b1", config, { maxChunks: 1000 });
    expect(report.truncated).toBe(true);
    const deletes = mockQuery.mock.calls.map((call) => String(call[0])).filter((sql) =>
      sql.includes("DELETE FROM ai_embeddings"),
    );
    expect(deletes).toHaveLength(0);
  });

  it("skips a chunk with no embeddable text, with a named reason", async () => {
    mockQuery.mockImplementation((async (sql: string) => {
      if (String(sql).includes("FROM customers WHERE")) {
        return { rows: [{ ref_id: "c1", name: "   " }] };
      }
      return { rows: [] };
    }) as never);
    const report = await reindexBusinessKnowledge("b1", config);
    expect(report.embedded).toBe(0);
    expect(report.skipped).toContain("customer:empty_content");
  });

  it("stops embedding but does not throw when a batch fails", async () => {
    mockQuery.mockImplementation((async (sql: string) => {
      if (String(sql).includes("FROM menu_items mi")) {
        return {
          rows: [
            { ref_id: "m1", name: "یک", description: null },
            { ref_id: "m2", name: "دو", description: null },
          ],
        };
      }
      return { rows: [] };
    }) as never);
    mockEmbedTexts.mockRejectedValue(new Error("embeddings_http_500"));
    const report = await reindexBusinessKnowledge("b1", config);
    expect(report.embedded).toBe(0);
  });

  it("is bounded by default", () => {
    expect(DEFAULT_MAX_CHUNKS).toBeLessThanOrEqual(5000);
  });
});
