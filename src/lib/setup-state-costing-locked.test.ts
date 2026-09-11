/**
 * سیستم ادواری × the costing lock. A perpetual business locks its
 * method/system choice on the first stock movement; a periodic business
 * never writes stock movements, so the same lock must sit on its first
 * received purchase (journal-only) or first period close instead. This
 * pins costingLocked's decision table over mocked settings/db reads.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as settings from "./settings";
import * as db from "./db";
import { costingLocked, type CostingSetting } from "./setup-state";

vi.mock("./settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./settings")>();
  return { ...actual, getSetting: vi.fn() };
});

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return { ...actual, query: vi.fn() };
});

function mockCounts({ stockMovements, periodicActivity }: { stockMovements: number; periodicActivity: number }) {
  vi.mocked(db.query).mockImplementation(async (sql: string) => {
    if (sql.includes("FROM stock_movements")) return { rows: [{ n: String(stockMovements) }] } as never;
    if (sql.includes("FROM periodic_closings")) return { rows: [{ n: String(periodicActivity) }] } as never;
    throw new Error(`unexpected query: ${sql.replace(/\s+/g, " ").trim()}`);
  });
}

function mockCosting(costing: CostingSetting | null) {
  vi.mocked(settings.getSetting).mockResolvedValue(costing);
}

beforeEach(() => {
  vi.mocked(settings.getSetting).mockReset();
  vi.mocked(db.query).mockReset();
});

describe("costingLocked", () => {
  it("locks on lockedAt alone, before counting anything", async () => {
    mockCosting({ method: "fifo", system: "perpetual", lockedAt: "2026-01-01T00:00:00Z" });
    expect(await costingLocked("biz-1")).toBe(true);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("locks on the first stock movement (the perpetual rule)", async () => {
    mockCosting({ method: "fifo", system: "perpetual", lockedAt: null });
    mockCounts({ stockMovements: 1, periodicActivity: 0 });
    expect(await costingLocked("biz-1")).toBe(true);
  });

  it("locks a periodic business on its first received purchase or period close, with zero stock movements", async () => {
    mockCosting({ method: "weighted_average", system: "periodic", lockedAt: null });
    mockCounts({ stockMovements: 0, periodicActivity: 1 });
    expect(await costingLocked("biz-1")).toBe(true);
  });

  it("stays open when nothing has happened yet", async () => {
    mockCosting({ method: "lifo", system: "periodic", lockedAt: null });
    mockCounts({ stockMovements: 0, periodicActivity: 0 });
    expect(await costingLocked("biz-1")).toBe(false);
  });

  it("stays open for a business with no costing setting and no activity", async () => {
    mockCosting(null);
    mockCounts({ stockMovements: 0, periodicActivity: 0 });
    expect(await costingLocked("biz-1")).toBe(false);
  });
});
