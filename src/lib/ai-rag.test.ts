import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ query: vi.fn() }));

import { query } from "./db";
import {
  DEFAULT_RETRIEVAL_LIMIT,
  EMBEDDABLE_KINDS,
  EMBEDDING_DIMENSIONS,
  MAX_CONTENT_CHARS,
  MAX_RETRIEVAL_LIMIT,
  NEVER_EMBEDDED_KINDS,
  clampRetrievalLimit,
  countStaleEmbeddings,
  formatRetrievalForPrompt,
  isEmbeddableKind,
  isRetrievalAvailable,
  normalizeContent,
  rejectionReason,
  resetRetrievalAvailabilityCache,
  retrieveKnowledge,
  toVectorLiteral,
  upsertEmbedding,
  type RetrievalResult,
} from "./ai-rag";

const mockQuery = vi.mocked(query);

function vector(fill = 0.1): number[] {
  return new Array(EMBEDDING_DIMENSIONS).fill(fill);
}

beforeEach(() => {
  mockQuery.mockReset();
  resetRetrievalAvailabilityCache();
});

describe("the embeddable kinds", () => {
  it("accepts only slow-moving text kinds", () => {
    for (const kind of EMBEDDABLE_KINDS) {
      expect(isEmbeddableKind(kind)).toBe(true);
    }
  });

  it("never embeds a kind that carries live figures", () => {
    for (const kind of NEVER_EMBEDDED_KINDS) {
      expect(isEmbeddableKind(kind)).toBe(false);
    }
  });

  it("rejects unknown and non-string kinds", () => {
    expect(isEmbeddableKind("ledger")).toBe(false);
    expect(isEmbeddableKind(undefined)).toBe(false);
    expect(isEmbeddableKind(42)).toBe(false);
  });
});

describe("normalizeContent", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizeContent("  نان\n\tبربری   تازه  ")).toBe("نان بربری تازه");
  });

  it("clamps to the embedding budget", () => {
    expect(normalizeContent("a".repeat(MAX_CONTENT_CHARS + 500)).length).toBe(MAX_CONTENT_CHARS);
  });

  it("returns an empty string for whitespace-only input", () => {
    expect(normalizeContent("   \n  ")).toBe("");
  });
});

describe("rejectionReason", () => {
  it("passes a well-formed text chunk", () => {
    expect(
      rejectionReason({ kind: "project_note", refId: "n1", content: "سیاست تخفیف" }),
    ).toBeNull();
  });

  it("refuses a kind that would copy numbers into a vector", () => {
    expect(rejectionReason({ kind: "order", refId: "o1", content: "۱۲۳" })).toBe(
      "kind_not_embeddable",
    );
    expect(rejectionReason({ kind: "journal_entry", refId: "j1", content: "x" })).toBe(
      "kind_not_embeddable",
    );
  });

  it("refuses a missing ref id", () => {
    expect(rejectionReason({ kind: "item", refId: "  ", content: "نان" })).toBe("missing_ref_id");
    expect(rejectionReason({ kind: "item", content: "نان" })).toBe("missing_ref_id");
  });

  it("refuses empty content", () => {
    expect(rejectionReason({ kind: "help", refId: "h1", content: "   " })).toBe("empty_content");
  });
});

describe("clampRetrievalLimit", () => {
  it("defaults to five relevant rows, not a catalogue", () => {
    expect(clampRetrievalLimit(undefined)).toBe(DEFAULT_RETRIEVAL_LIMIT);
    expect(clampRetrievalLimit(Number.NaN)).toBe(DEFAULT_RETRIEVAL_LIMIT);
  });

  it("clamps to the allowed window", () => {
    expect(clampRetrievalLimit(0)).toBe(1);
    expect(clampRetrievalLimit(-3)).toBe(1);
    expect(clampRetrievalLimit(1000)).toBe(MAX_RETRIEVAL_LIMIT);
  });

  it("keeps a sane value and floors a fractional one", () => {
    expect(clampRetrievalLimit(7)).toBe(7);
    expect(clampRetrievalLimit(7.9)).toBe(7);
  });
});

describe("toVectorLiteral", () => {
  it("renders pgvector's own literal form", () => {
    const literal = toVectorLiteral(vector(0.5));
    expect(literal.startsWith("[0.5,")).toBe(true);
    expect(literal.endsWith("]")).toBe(true);
  });

  it("refuses a wrong dimension count", () => {
    expect(() => toVectorLiteral([1, 2, 3])).toThrow(/1536 dimensions/);
  });

  it("refuses a non-finite component", () => {
    const bad = vector();
    bad[10] = Number.POSITIVE_INFINITY;
    expect(() => toVectorLiteral(bad)).toThrow(/non-finite/);
  });
});

describe("formatRetrievalForPrompt", () => {
  const results: RetrievalResult[] = [
    {
      kind: "item",
      refId: "i1",
      sourceLabel: "نان بربری",
      content: "نان سنتی",
      similarity: 0.9,
    },
    {
      kind: "project_note",
      refId: "n1",
      sourceLabel: "کمپین نوروز",
      content: "تخفیف ۲۰٪",
      similarity: 0.8,
    },
  ];

  it("names the source of every result so the answer is traceable", () => {
    const text = formatRetrievalForPrompt(results);
    expect(text).toContain("نان بربری");
    expect(text).toContain("کمپین نوروز");
    expect(text).toContain("item");
    expect(text).toContain("project_note");
  });

  it("falls back to the ref id when there is no label", () => {
    const text = formatRetrievalForPrompt([{ ...results[0], sourceLabel: "" }]);
    expect(text).toContain("i1");
  });

  it("returns an empty string when nothing was retrieved", () => {
    expect(formatRetrievalForPrompt([])).toBe("");
  });
});

describe("isRetrievalAvailable", () => {
  it("is true when the extension and the table both exist", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: true }] } as never);
    await expect(isRetrievalAvailable()).resolves.toBe(true);
  });

  it("is false when pgvector is absent", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: false }] } as never);
    await expect(isRetrievalAvailable()).resolves.toBe(false);
  });

  it("degrades to false rather than throwing when the probe itself fails", async () => {
    mockQuery.mockRejectedValueOnce(new Error("type \"vector\" does not exist"));
    await expect(isRetrievalAvailable()).resolves.toBe(false);
  });

  it("probes once and caches the answer", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: true }] } as never);
    await isRetrievalAvailable();
    await isRetrievalAvailable();
    await isRetrievalAvailable();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe("retrieveKnowledge — safe degradation", () => {
  it("returns nothing and issues no search when pgvector is missing", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: false }] } as never);
    await expect(retrieveKnowledge("b1", vector())).resolves.toEqual([]);
    expect(mockQuery).toHaveBeenCalledTimes(1); // the probe only
  });

  it("returns nothing rather than throwing when the search fails", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: true }] } as never);
    mockQuery.mockRejectedValueOnce(new Error("index missing"));
    await expect(retrieveKnowledge("b1", vector())).resolves.toEqual([]);
  });

  it("maps rows and their similarity", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: true }] } as never);
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          kind: "item",
          ref_id: "i1",
          source_label: "نان بربری",
          content: "نان سنتی",
          similarity: "0.87",
        },
      ],
    } as never);
    const results = await retrieveKnowledge("b1", vector());
    expect(results).toEqual([
      {
        kind: "item",
        refId: "i1",
        sourceLabel: "نان بربری",
        content: "نان سنتی",
        similarity: 0.87,
      },
    ]);
  });

  it("scopes the search to one business", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: true }] } as never);
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    await retrieveKnowledge("b1", vector());
    const [sql, params] = mockQuery.mock.calls[1];
    expect(sql).toContain("business_id = $1");
    expect((params as unknown[])[0]).toBe("b1");
  });

  it("drops a row whose stored kind is no longer embeddable", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: true }] } as never);
    mockQuery.mockResolvedValueOnce({
      rows: [
        { kind: "order", ref_id: "o1", source_label: "", content: "x", similarity: "0.99" },
        { kind: "help", ref_id: "h1", source_label: "راهنما", content: "y", similarity: "0.5" },
      ],
    } as never);
    const results = await retrieveKnowledge("b1", vector());
    expect(results.map((r) => r.kind)).toEqual(["help"]);
  });
});

describe("upsertEmbedding", () => {
  it("refuses to embed a kind that carries figures", async () => {
    await expect(
      upsertEmbedding(
        "b1",
        { kind: "order" as never, refId: "o1", sourceLabel: "", content: "۱۲۳" },
        vector(),
      ),
    ).rejects.toThrow(/kind_not_embeddable/);
  });

  it("writes nothing when retrieval is unavailable", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: false }] } as never);
    const stored = await upsertEmbedding(
      "b1",
      { kind: "help", refId: "h1", sourceLabel: "راهنما", content: "متن" },
      vector(),
    );
    expect(stored).toBe(false);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("upserts on (business, kind, ref) when available", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: true }] } as never);
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    const stored = await upsertEmbedding(
      "b1",
      { kind: "help", refId: "h1", sourceLabel: "راهنما", content: "  متن   راهنما " },
      vector(),
    );
    expect(stored).toBe(true);
    const [sql, params] = mockQuery.mock.calls[1];
    expect(sql).toContain("ON CONFLICT (business_id, kind, ref_id) DO UPDATE");
    expect((params as unknown[])[4]).toBe("متن راهنما");
  });
});

describe("countStaleEmbeddings", () => {
  it("is zero when retrieval is unavailable", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: false }] } as never);
    await expect(countStaleEmbeddings("b1")).resolves.toBe(0);
  });

  it("counts rows whose source moved on after they were embedded", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: true }] } as never);
    mockQuery.mockResolvedValueOnce({ rows: [{ n: "4" }] } as never);
    await expect(countStaleEmbeddings("b1")).resolves.toBe(4);
  });
});
