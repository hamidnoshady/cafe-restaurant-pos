import { describe, expect, it } from "vitest";
import {
  FISCAL_PERIOD_COUNT,
  FISCAL_YEAR_MAX,
  FISCAL_YEAR_MIN,
  canTransitionPeriod,
  fiscalYearSpec,
  isSupportedFiscalYear,
} from "./fiscal-periods";

describe("fiscalYearSpec", () => {
  it("keeps the financial-year entry boundary explicit and inclusive", () => {
    expect(isSupportedFiscalYear(FISCAL_YEAR_MIN)).toBe(true);
    expect(isSupportedFiscalYear(FISCAL_YEAR_MAX)).toBe(true);
    expect(isSupportedFiscalYear(FISCAL_YEAR_MIN - 1)).toBe(false);
    expect(isSupportedFiscalYear(FISCAL_YEAR_MAX + 1)).toBe(false);
    expect(isSupportedFiscalYear(1404.5)).toBe(false);
  });

  it("starts the year on Nowruz and ends on the last day of Esfand", () => {
    const spec = fiscalYearSpec(1404);
    expect(spec.label).toBe("1404");
    expect(spec.startsOn).toBe("2025-03-21");
    expect(spec.periods).toHaveLength(FISCAL_PERIOD_COUNT);
    expect(spec.endsOn).toBe(spec.periods[11].endsOn);
  });

  it("produces twelve contiguous periods with no gaps or overlaps", () => {
    const spec = fiscalYearSpec(1404);
    for (let i = 0; i < spec.periods.length; i++) {
      const p = spec.periods[i];
      expect(p.label).toBe(`1404-${String(i + 1).padStart(2, "0")}`);
      expect(new Date(p.endsOn).getTime()).toBeGreaterThan(new Date(p.startsOn).getTime());
      if (i > 0) {
        const prevEnd = new Date(spec.periods[i - 1].endsOn);
        const thisStart = new Date(p.startsOn);
        expect(thisStart.getTime() - prevEnd.getTime()).toBe(24 * 60 * 60 * 1000);
      }
    }
  });

  it("gives Esfand 29 days in a common year and 30 in a leap year", () => {
    // 1403 is leap (30-day Esfand); 1404 is common (29-day Esfand).
    expect(fiscalYearSpec(1403).periods[11].endsOn).toBe("2025-03-20");
    expect(fiscalYearSpec(1404).periods[11].endsOn).toBe("2026-03-20");
  });
});

describe("canTransitionPeriod", () => {
  it("allows the documented lifecycle: open -> soft_closed -> locked, and reopening from either", () => {
    expect(canTransitionPeriod("open", "soft_closed")).toBe(true);
    expect(canTransitionPeriod("soft_closed", "locked")).toBe(true);
    expect(canTransitionPeriod("soft_closed", "open")).toBe(true);
    expect(canTransitionPeriod("locked", "open")).toBe(true);
  });

  it("rejects skipping straight from open to locked, or a no-op transition", () => {
    expect(canTransitionPeriod("open", "locked")).toBe(false);
    expect(canTransitionPeriod("open", "open")).toBe(false);
    expect(canTransitionPeriod("locked", "locked")).toBe(false);
  });
});
