import { describe, expect, it } from "vitest";
import { depreciableBase, depreciationForPeriod, monthlyDepreciation, validateFixedAsset } from "./depreciation";

describe("depreciableBase", () => {
  it("is cost minus salvage value", () => {
    expect(depreciableBase({ cost: 120_000_000, salvageValue: 20_000_000, usefulLifeMonths: 60 })).toBe(100_000_000);
  });

  it("is the full cost when there's no salvage value", () => {
    expect(depreciableBase({ cost: 60_000_000, salvageValue: 0, usefulLifeMonths: 24 })).toBe(60_000_000);
  });
});

describe("monthlyDepreciation", () => {
  it("spreads the depreciable base evenly over the useful life", () => {
    expect(monthlyDepreciation({ cost: 120_000_000, salvageValue: 0, usefulLifeMonths: 60 })).toBe(2_000_000);
  });

  it("rounds to the nearest whole Rial", () => {
    // 100/3 = 33.333...
    expect(monthlyDepreciation({ cost: 100, salvageValue: 0, usefulLifeMonths: 3 })).toBe(33);
  });
});

describe("depreciationForPeriod", () => {
  const asset = { cost: 100_000, salvageValue: 10_000, usefulLifeMonths: 9 };
  // depreciableBase = 90_000, monthlyDepreciation = 10_000

  it("is the regular monthly amount when nothing's accumulated yet", () => {
    expect(depreciationForPeriod(asset, 0, 0)).toBe(10_000);
  });

  it("is the regular monthly amount mid-schedule, even if less than what remains", () => {
    // period index 5 of 9 (periodsPostedSoFar=4) — not the final period yet.
    expect(depreciationForPeriod(asset, 40_000, 4)).toBe(10_000);
  });

  it("absorbs whatever's left of the depreciable base on the final scheduled period, even if that's more than the regular monthly amount", () => {
    // periodsPostedSoFar=8 -> this would be period 9 of 9, the final one.
    expect(depreciationForPeriod(asset, 75_000, 8)).toBe(15_000);
  });

  it("is zero once fully depreciated", () => {
    expect(depreciationForPeriod(asset, 90_000, 9)).toBe(0);
  });

  it("is zero if somehow over-depreciated (defensive, shouldn't happen)", () => {
    expect(depreciationForPeriod(asset, 95_000, 9)).toBe(0);
  });

  it("rounding: three periods of a 100,000-over-3-months asset sum to exactly the depreciable base", () => {
    const roundingAsset = { cost: 100_000, salvageValue: 0, usefulLifeMonths: 3 };
    const p1 = depreciationForPeriod(roundingAsset, 0, 0);
    const p2 = depreciationForPeriod(roundingAsset, p1, 1);
    const p3 = depreciationForPeriod(roundingAsset, p1 + p2, 2);
    expect(p1).toBe(33_333);
    expect(p2).toBe(33_333);
    expect(p3).toBe(33_334); // absorbs the rounding remainder on the final period
    expect(p1 + p2 + p3).toBe(100_000);
  });
});

describe("validateFixedAsset", () => {
  const VALID = {
    name: "یخچال صنعتی",
    acquisitionDate: "2025-01-15",
    cost: 100_000_000,
    salvageValue: 10_000_000,
    usefulLifeMonths: 60,
  };

  it("accepts a well-formed asset", () => {
    expect(validateFixedAsset(VALID)).toEqual([]);
  });

  it("rejects an empty name", () => {
    expect(validateFixedAsset({ ...VALID, name: "  " }).length).toBeGreaterThan(0);
  });

  it("rejects a missing or invalid acquisition date", () => {
    expect(validateFixedAsset({ ...VALID, acquisitionDate: "" }).length).toBeGreaterThan(0);
    expect(validateFixedAsset({ ...VALID, acquisitionDate: "not-a-date" }).length).toBeGreaterThan(0);
  });

  it("rejects a non-positive cost", () => {
    expect(validateFixedAsset({ ...VALID, cost: 0 }).length).toBeGreaterThan(0);
    expect(validateFixedAsset({ ...VALID, cost: -1 }).length).toBeGreaterThan(0);
  });

  it("rejects a negative salvage value", () => {
    expect(validateFixedAsset({ ...VALID, salvageValue: -1 }).length).toBeGreaterThan(0);
  });

  it("rejects a salvage value that isn't less than cost", () => {
    expect(validateFixedAsset({ ...VALID, salvageValue: VALID.cost }).length).toBeGreaterThan(0);
    expect(validateFixedAsset({ ...VALID, salvageValue: VALID.cost + 1 }).length).toBeGreaterThan(0);
  });

  it("rejects a non-positive or fractional useful life", () => {
    expect(validateFixedAsset({ ...VALID, usefulLifeMonths: 0 }).length).toBeGreaterThan(0);
    expect(validateFixedAsset({ ...VALID, usefulLifeMonths: 12.5 }).length).toBeGreaterThan(0);
  });
});
