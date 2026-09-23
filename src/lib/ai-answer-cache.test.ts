import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ query: vi.fn() }));

import { query } from "./db";
import {
  CACHEABLE_MODES,
  CACHE_NOTICE,
  CACHE_SIMILARITY_THRESHOLD,
  CACHE_TTL_SECONDS,
  EMBEDDING_DIMENSIONS,
  buildToolSignature,
  clearCache,
  invalidateByRange,
  invalidateTodayForBusiness,
  isAnswerCacheAvailable,
  isCacheableTurn,
  lookupCachedAnswer,
  normalizeRangeDate,
  resetAnswerCacheAvailability,
  signatureTouchesRange,
  storeCachedAnswer,
  sweepExpiredAnswers,
  type TurnShape,
} from "./ai-answer-cache";

const mockQuery = vi.mocked(query);

function vector(fill = 0.2): number[] {
  return new Array(EMBEDDING_DIMENSIONS).fill(fill);
}

const READ_TOOLS = ["get_sales_summary", "find_items", "get_waste_history"];

function readOnlyTurn(overrides: Partial<TurnShape> = {}): TurnShape {
  return {
    mode: "dashboard",
    toolsUsed: ["get_sales_summary"],
    proposedAction: false,
    readToolNames: READ_TOOLS,
    ...overrides,
  };
}

const key = {
  businessId: "b1",
  locationId: "l1",
  businessDate: "2026-08-27",
  toolSignature: "get_sales_summary:2026-08-27..2026-08-27",
};

beforeEach(() => {
  mockQuery.mockReset();
  resetAnswerCacheAvailability();
});

describe("isCacheableTurn — the read-only gate", () => {
  it("accepts a plain read-only question", () => {
    expect(isCacheableTurn(readOnlyTurn())).toBe(true);
  });

  it("never caches a turn that proposed a write", () => {
    expect(isCacheableTurn(readOnlyTurn({ proposedAction: true }))).toBe(false);
  });

  it("never caches a turn that touched a tool outside the read set", () => {
    expect(
      isCacheableTurn(readOnlyTurn({ toolsUsed: ["get_sales_summary", "propose_action"] })),
    ).toBe(false);
  });

  it("never caches wizard or autopilot modes", () => {
    expect(isCacheableTurn(readOnlyTurn({ mode: "wizard" }))).toBe(false);
    expect(isCacheableTurn(readOnlyTurn({ mode: "autopilot" }))).toBe(false);
    expect(isCacheableTurn(readOnlyTurn({ mode: "proactive" }))).toBe(false);
  });

  it("caches only the modes on the allow list", () => {
    for (const mode of CACHEABLE_MODES) {
      expect(isCacheableTurn(readOnlyTurn({ mode }))).toBe(true);
    }
  });

  it("caches a turn that used no tools at all", () => {
    expect(isCacheableTurn(readOnlyTurn({ toolsUsed: [] }))).toBe(true);
  });
});

describe("buildToolSignature", () => {
  it("is independent of call order", () => {
    const a = buildToolSignature([
      { tool: "get_sales_summary", from: "2026-08-27", to: "2026-08-27" },
      { tool: "find_items" },
    ]);
    const b = buildToolSignature([
      { tool: "find_items" },
      { tool: "get_sales_summary", from: "2026-08-27", to: "2026-08-27" },
    ]);
    expect(a).toBe(b);
  });

  it("distinguishes the same tool over different ranges", () => {
    const today = buildToolSignature([
      { tool: "get_sales_summary", from: "2026-08-27", to: "2026-08-27" },
    ]);
    const yesterday = buildToolSignature([
      { tool: "get_sales_summary", from: "2026-08-26", to: "2026-08-26" },
    ]);
    expect(today).not.toBe(yesterday);
  });

  it("de-duplicates repeated identical calls", () => {
    const sig = buildToolSignature([{ tool: "find_items" }, { tool: "find_items" }]);
    expect(sig).toBe("find_items:*..*");
  });

  it("has an explicit signature for a turn with no tools", () => {
    expect(buildToolSignature([])).toBe("none");
  });
});

describe("signatureTouchesRange — invalidation", () => {
  const sig = buildToolSignature([
    { tool: "get_sales_summary", from: "2026-08-20", to: "2026-08-27" },
  ]);

  it("invalidates a sale posted onto an earlier day inside the signed range", () => {
    expect(signatureTouchesRange(sig, { from: "2026-08-22", to: "2026-08-22" })).toBe(true);
  });

  it("invalidates a write on the boundary day", () => {
    expect(signatureTouchesRange(sig, { from: "2026-08-20", to: "2026-08-20" })).toBe(true);
    expect(signatureTouchesRange(sig, { from: "2026-08-27", to: "2026-08-27" })).toBe(true);
  });

  it("leaves an answer alone when the write is outside its range", () => {
    expect(signatureTouchesRange(sig, { from: "2026-08-28", to: "2026-08-28" })).toBe(false);
    expect(signatureTouchesRange(sig, { from: "2026-08-01", to: "2026-08-19" })).toBe(false);
  });

  it("treats an open-ended range as covering everything after its bound", () => {
    const open = buildToolSignature([{ tool: "get_sales_summary", from: "2026-08-20" }]);
    expect(signatureTouchesRange(open, { from: "2027-01-01", to: "2027-01-01" })).toBe(true);
    expect(signatureTouchesRange(open, { from: "2026-01-01", to: "2026-01-01" })).toBe(false);
  });

  it("never invalidates a tool-free answer by range", () => {
    expect(signatureTouchesRange("none", { from: "2026-08-22", to: "2026-08-22" })).toBe(false);
  });
});

describe("isAnswerCacheAvailable", () => {
  it("is false when pgvector is absent", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: false }] } as never);
    await expect(isAnswerCacheAvailable()).resolves.toBe(false);
  });

  it("degrades to false rather than throwing", async () => {
    mockQuery.mockRejectedValueOnce(new Error("no such type: vector"));
    await expect(isAnswerCacheAvailable()).resolves.toBe(false);
  });

  it("probes once", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: true }] } as never);
    await isAnswerCacheAvailable();
    await isAnswerCacheAvailable();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe("lookupCachedAnswer", () => {
  it("misses without querying when the cache is off", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: false }] } as never);
    await expect(lookupCachedAnswer(key, vector())).resolves.toBeNull();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("always misses when the user pressed «دوباره بپرس»", async () => {
    await expect(lookupCachedAnswer(key, vector(), { bypass: true })).resolves.toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("requires the business day, the signature and the expiry all at once", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: true }] } as never);
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    await lookupCachedAnswer(key, vector());
    const [sql, params] = mockQuery.mock.calls[1];
    expect(sql).toContain("business_date = $3");
    expect(sql).toContain("tool_signature = $4");
    expect(sql).toContain("expires_at > now()");
    expect(sql).toContain("business_id = $1");
    expect((params as unknown[])[2]).toBe("2026-08-27");
    expect((params as unknown[])[5]).toBe(CACHE_SIMILARITY_THRESHOLD);
  });

  it("labels a hit explicitly and counts it", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: true }] } as never);
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "c1",
          answer: "فروش دیروز ۱۲٬۰۰۰٬۰۰۰ ریال بود.",
          question_text: "فروش دیروز چقدر بود؟",
          hit_count: 2,
          similarity: "0.97",
        },
      ],
    } as never);
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    const hit = await lookupCachedAnswer(key, vector());
    expect(hit?.notice).toBe(CACHE_NOTICE);
    expect(hit?.hitCount).toBe(3);
    expect(hit?.similarity).toBe(0.97);
    expect(mockQuery.mock.calls[2][0]).toContain("hit_count = hit_count + 1");
  });

  it("misses rather than throwing when the lookup fails", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: true }] } as never);
    mockQuery.mockRejectedValueOnce(new Error("boom"));
    await expect(lookupCachedAnswer(key, vector())).resolves.toBeNull();
  });
});

describe("storeCachedAnswer", () => {
  const input = {
    questionText: "فروش دیروز چقدر بود؟",
    questionEmbedding: vector(),
    answer: "۱۲٬۰۰۰٬۰۰۰ ریال",
    turn: readOnlyTurn(),
  };

  it("refuses a turn that proposed an action, without even probing", async () => {
    const stored = await storeCachedAnswer(key, {
      ...input,
      turn: readOnlyTurn({ proposedAction: true }),
    });
    expect(stored).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("stores nothing when the cache is off", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: false }] } as never);
    await expect(storeCachedAnswer(key, input)).resolves.toBe(false);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("stores the business day and the signature with a TTL", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: true }] } as never);
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    await expect(storeCachedAnswer(key, input)).resolves.toBe(true);
    const [sql, params] = mockQuery.mock.calls[1];
    expect(sql).toContain("INSERT INTO ai_answer_cache");
    expect((params as unknown[])[4]).toBe("2026-08-27");
    expect((params as unknown[])[5]).toBe(key.toolSignature);
    expect((params as unknown[])[7]).toBe(String(CACHE_TTL_SECONDS));
  });
});

describe("invalidateByRange", () => {
  it("does nothing when the cache is off", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: false }] } as never);
    await expect(invalidateByRange("b1", { from: "2026-08-22", to: "2026-08-22" })).resolves.toBe(
      0,
    );
  });

  it("deletes only the answers whose signed range the write touched", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: true }] } as never);
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: "c1", tool_signature: "get_sales_summary:2026-08-20..2026-08-27" },
        { id: "c2", tool_signature: "get_sales_summary:2026-09-01..2026-09-05" },
        { id: "c3", tool_signature: "none" },
      ],
    } as never);
    mockQuery.mockResolvedValueOnce({ rowCount: 1 } as never);
    const removed = await invalidateByRange("b1", { from: "2026-08-22", to: "2026-08-22" });
    expect(removed).toBe(1);
    expect(mockQuery.mock.calls[2][1]).toEqual(["b1", ["c1"]]);
  });

  it("issues no delete when nothing matched", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: true }] } as never);
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "c2", tool_signature: "get_sales_summary:2026-09-01..2026-09-05" }],
    } as never);
    await expect(invalidateByRange("b1", { from: "2026-08-22", to: "2026-08-22" })).resolves.toBe(
      0,
    );
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});

describe("manual clearing and sweeping", () => {
  it("clears one business's cache and no other", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: true }] } as never);
    mockQuery.mockResolvedValueOnce({ rowCount: 5 } as never);
    await expect(clearCache("b1")).resolves.toBe(5);
    const [sql, params] = mockQuery.mock.calls[1];
    expect(sql).toContain("business_id = $1");
    expect(params).toEqual(["b1"]);
  });

  it("sweeps only rows past their TTL", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: true }] } as never);
    mockQuery.mockResolvedValueOnce({ rowCount: 2 } as never);
    await expect(sweepExpiredAnswers("b1")).resolves.toBe(2);
    expect(mockQuery.mock.calls[1][0]).toContain("expires_at <= now()");
  });

  it("is a no-op when the cache is off", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: false }] } as never);
    await expect(sweepExpiredAnswers("b1")).resolves.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 36 wiring — signature-agnostic lookup, range normalisation, and the
// fresh-order invalidation hook.
// ---------------------------------------------------------------------------

describe("lookupCachedAnswer with a null signature", () => {
  it("matches any stored signature but keeps every other key part", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: true }] } as never);
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    await lookupCachedAnswer({ ...key, toolSignature: null }, vector());
    const [sql, params] = mockQuery.mock.calls[1];
    expect(sql).toContain("($4::text IS NULL OR tool_signature = $4)");
    expect((params as unknown[])[3]).toBeNull();
    expect((params as unknown[])[2]).toBe("2026-08-27");
  });
});

describe("normalizeRangeDate", () => {
  it("keeps a plain ISO date", () => {
    expect(normalizeRangeDate("2026-08-27")).toBe("2026-08-27");
  });

  it("trims a timestamp down to its date", () => {
    expect(normalizeRangeDate("2026-08-27T18:30:00.000Z")).toBe("2026-08-27");
  });

  it("normalises an unparseable value to null, which renders as the unbounded *", () => {
    expect(normalizeRangeDate("دیروز")).toBeNull();
    expect(normalizeRangeDate(undefined)).toBeNull();
    // And * in the signature is what every write invalidates:
    expect(signatureTouchesRange("run_report:*..*", { from: "2026-01-01", to: "2026-01-01" })).toBe(
      true,
    );
  });
});

describe("invalidateTodayForBusiness — the fresh-order hook", () => {
  it("invalidates the business's current trading day", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: true }] } as never); // cache available
    mockQuery.mockResolvedValueOnce({ rows: [{ today: "2026-08-27" }] } as never); // businessToday
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "c1", tool_signature: "run_report:2026-08-20..2026-08-27" }],
    } as never); // candidate rows
    mockQuery.mockResolvedValueOnce({ rowCount: 1 } as never); // delete
    await expect(invalidateTodayForBusiness("b1")).resolves.toBe(1);
    expect(mockQuery.mock.calls[1][0]).toContain("app_business_date");
    // The delete is scoped to the tenant and to the touching rows only.
    const [deleteSql, deleteParams] = mockQuery.mock.calls[3];
    expect(deleteSql).toContain("DELETE FROM ai_answer_cache");
    expect((deleteParams as unknown[])[0]).toBe("b1");
  });

  it("is a silent no-op when the business date cannot be read", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: true }] } as never);
    mockQuery.mockRejectedValueOnce(new Error("boom"));
    await expect(invalidateTodayForBusiness("b1")).resolves.toBe(0);
  });

  it("does nothing when the cache is off", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: false }] } as never);
    await expect(invalidateTodayForBusiness("b1")).resolves.toBe(0);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});
