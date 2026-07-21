import { describe, expect, it } from "vitest";
import {
  addDays,
  computePushFromDay,
  generateRollupToken,
  hashRollupToken,
  isSyncStale,
  isValidBusinessDay,
  MAX_DAYS_PER_PUSH,
  MAX_STAFF_PER_DAY,
  RESEND_OVERLAP_DAYS,
  validateRollupPayload,
  type RollupDay,
  type RollupPushPayload,
} from "./rollup";

const LOC_ID = "3f1f8a80-6c2a-4a37-9d55-0b6a9a3d2f10";
const STAFF_ID = "9e07c1f2-1b3d-4a5e-8f60-2c4d6e8f0a1b";

function day(overrides: Partial<RollupDay> = {}): RollupDay {
  return {
    businessDay: "2026-07-20", // ISO/Gregorian in storage/transport; Jalali is display-only
    orderCount: 12,
    subtotal: 24_000_000,
    discount: 1_000_000,
    serviceCharge: 0,
    tax: 2_300_000,
    total: 25_300_000,
    cashTotal: 10_000_000,
    cardTotal: 15_300_000,
    onlineTotal: 0,
    creditTotal: 0,
    cogs: 8_000_000,
    wasteCost: 450_000,
    staff: [
      { staffId: STAFF_ID, staffName: "صندوق‌دار نمونه", role: "cashier", orderCount: 12, revenue: 25_300_000 },
    ],
    ...overrides,
  };
}

function payload(overrides: Partial<RollupPushPayload> = {}): RollupPushPayload {
  return {
    location: { id: LOC_ID, name: "شعبه مرکزی", timezone: "Asia/Tehran" },
    days: [day()],
    ...overrides,
  };
}

describe("rollup tokens", () => {
  it("generates distinct rlk_-prefixed tokens", () => {
    const a = generateRollupToken();
    const b = generateRollupToken();
    expect(a).toMatch(/^rlk_[0-9a-f]{48}$/);
    expect(a).not.toBe(b);
  });

  it("hashes deterministically, and differently for different tokens", () => {
    const t = generateRollupToken();
    expect(hashRollupToken(t)).toBe(hashRollupToken(t));
    expect(hashRollupToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRollupToken(t)).not.toBe(hashRollupToken(generateRollupToken()));
  });
});

describe("validateRollupPayload", () => {
  it("accepts a well-formed payload", () => {
    const res = validateRollupPayload(payload());
    expect(res.ok).toBe(true);
  });

  it("accepts an empty days list (heartbeat push)", () => {
    expect(validateRollupPayload(payload({ days: [] })).ok).toBe(true);
  });

  it("rejects non-objects and missing location", () => {
    expect(validateRollupPayload(null)).toEqual({ ok: false, error: "not_an_object" });
    expect(validateRollupPayload("x")).toEqual({ ok: false, error: "not_an_object" });
    expect(validateRollupPayload({ days: [] })).toEqual({ ok: false, error: "missing_location" });
  });

  it("rejects a non-uuid location id", () => {
    const p = payload();
    p.location.id = "not-a-uuid";
    expect(validateRollupPayload(p)).toEqual({ ok: false, error: "invalid_location_id" });
  });

  it("rejects malformed or impossible business days", () => {
    expect(validateRollupPayload(payload({ days: [day({ businessDay: "2026/07/20" })] }))).toEqual({
      ok: false,
      error: "invalid_business_day",
    });
    expect(validateRollupPayload(payload({ days: [day({ businessDay: "2026-02-30" })] }))).toEqual({
      ok: false,
      error: "invalid_business_day",
    });
  });

  it("rejects duplicate days in one push", () => {
    expect(validateRollupPayload(payload({ days: [day(), day()] }))).toEqual({
      ok: false,
      error: "duplicate_business_day",
    });
  });

  it("allows negative money (refund days) but not negative counts", () => {
    expect(validateRollupPayload(payload({ days: [day({ total: -500_000 })] })).ok).toBe(true);
    expect(validateRollupPayload(payload({ days: [day({ orderCount: -1 })] }))).toEqual({
      ok: false,
      error: "invalid_order_count",
    });
  });

  it("rejects unsafe / non-integer money values", () => {
    expect(validateRollupPayload(payload({ days: [day({ total: 0.5 })] }))).toEqual({
      ok: false,
      error: "invalid_total",
    });
    expect(validateRollupPayload(payload({ days: [day({ cogs: Number.MAX_SAFE_INTEGER + 1 })] }))).toEqual({
      ok: false,
      error: "invalid_cogs",
    });
  });

  it("rejects oversized pushes", () => {
    const many = Array.from({ length: MAX_DAYS_PER_PUSH + 1 }, (_, i) =>
      day({ businessDay: addDays("2020-01-01", i) }),
    );
    expect(validateRollupPayload(payload({ days: many }))).toEqual({ ok: false, error: "too_many_days" });

    const staff = Array.from({ length: MAX_STAFF_PER_DAY + 1 }, (_, i) => ({
      staffId: `${i.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
      staffName: `کارمند ${i}`,
      role: "waiter",
      orderCount: 1,
      revenue: 100_000,
    }));
    expect(validateRollupPayload(payload({ days: [day({ staff })] }))).toEqual({
      ok: false,
      error: "too_many_staff",
    });
  });

  it("rejects duplicate or malformed staff rows", () => {
    const s = { staffId: STAFF_ID, staffName: "الف", role: null, orderCount: 1, revenue: 1 };
    expect(validateRollupPayload(payload({ days: [day({ staff: [s, { ...s }] })] }))).toEqual({
      ok: false,
      error: "duplicate_staff_id",
    });
    expect(
      validateRollupPayload(payload({ days: [day({ staff: [{ ...s, staffName: " " }] })] })),
    ).toEqual({ ok: false, error: "invalid_staff_name" });
  });
});

describe("day arithmetic and push window", () => {
  it("addDays crosses month and year boundaries", () => {
    expect(addDays("2026-07-20", 1)).toBe("2026-07-21");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29"); // leap year
  });

  it("isValidBusinessDay accepts real dates only", () => {
    expect(isValidBusinessDay("2026-07-21")).toBe(true);
    expect(isValidBusinessDay("2026-13-01")).toBe(false);
    expect(isValidBusinessDay("2026-7-1")).toBe(false);
    expect(isValidBusinessDay(20260721)).toBe(false);
  });

  it("never-synced pushes everything (no lower bound)", () => {
    expect(computePushFromDay(null)).toBeNull();
    expect(computePushFromDay("garbage")).toBeNull();
  });

  it("re-pushes an overlap window before the last confirmed day", () => {
    expect(computePushFromDay("2026-07-21")).toBe(addDays("2026-07-21", -RESEND_OVERLAP_DAYS));
    expect(computePushFromDay("2026-01-01")).toBe("2025-12-30");
  });
});

describe("isSyncStale", () => {
  const now = new Date("2026-07-21T12:00:00Z");

  it("never-synced is stale", () => {
    expect(isSyncStale(null, now)).toBe(true);
  });

  it("recent sync is fresh, old sync is stale (24h default)", () => {
    expect(isSyncStale("2026-07-21T11:00:00Z", now)).toBe(false);
    expect(isSyncStale("2026-07-20T11:59:00Z", now)).toBe(true);
  });

  it("exactly at the threshold is still fresh", () => {
    expect(isSyncStale("2026-07-20T12:00:00Z", now)).toBe(false);
  });

  it("garbage timestamps count as stale rather than crashing", () => {
    expect(isSyncStale("not-a-date", now)).toBe(true);
  });
});
