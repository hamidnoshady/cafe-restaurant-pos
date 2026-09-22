/**
 * Unit tests for the plan allowance's pure half (migration 0168).
 *
 * The DB-consuming half (getPlanAllowance / consumePlanAllowanceTx and the
 * wallet settlement that drives it) is covered by
 * integration/ai-billing-flow.integration.test.ts against a real Postgres.
 * What lives here is the period key: an Iranian business's "month" must flip
 * at the Iranian midnight, not UTC's — a period computed in UTC would split
 * each day's turns across two months for three hours every evening (and a
 * whole extra month in winter), double-granting the allowance.
 */
import { describe, expect, it } from "vitest";
import { AI_BILLING_TIME_ZONE, currentPeriodMonth, periodMonthFor } from "./ai-plan-allowance";

describe("periodMonthFor", () => {
  it("formats the Tehran calendar month as YYYY-MM", () => {
    // 2025-06-15 10:00 UTC is 2025-06-15 13:30 in Tehran — same month.
    expect(periodMonthFor(new Date("2025-06-15T10:00:00Z"))).toBe("2025-06");
  });

  it("flips the month at the Tehran midnight, not UTC's", () => {
    // Tehran sits at UTC+3:30, so its midnight is 20:30 UTC.
    // 2025-08-31 19:30 UTC is 2025-08-31 23:00 in Tehran — still August.
    expect(periodMonthFor(new Date("2025-08-31T19:30:00Z"))).toBe("2025-08");
    // One second after Tehran's midnight (2025-09-01 00:00:01 there), the
    // period is September even though UTC is still on August 31.
    expect(periodMonthFor(new Date("2025-08-31T20:30:01Z"))).toBe("2025-09");
    // One second before it, the period is still the old month.
    expect(periodMonthFor(new Date("2025-08-31T20:29:59Z"))).toBe("2025-08");
  });

  it("keeps the last evening of a Tehran month in that month", () => {
    // 19:00 UTC on December 31 is 22:30 the same evening in Tehran — still
    // December; the Tehran midnight (20:30 UTC) is what flips it to January.
    expect(periodMonthFor(new Date("2024-12-31T19:00:00Z"))).toBe("2024-12");
    expect(periodMonthFor(new Date("2024-12-31T20:30:00Z"))).toBe("2025-01");
  });

  it("uses the billing calendar by default and supports an explicit zone", () => {
    expect(AI_BILLING_TIME_ZONE).toBe("Asia/Tehran");
    // Late on June 30 in Tehran (19:30 local) but already July 1 in Sydney.
    const moment = new Date("2025-06-30T16:00:00Z");
    expect(periodMonthFor(moment)).toBe("2025-06");
    expect(periodMonthFor(moment, "Australia/Sydney")).toBe("2025-07");
  });

  it("keys the current period in the same calendar", () => {
    expect(currentPeriodMonth()).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
  });
});
