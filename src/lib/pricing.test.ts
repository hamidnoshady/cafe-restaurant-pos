import { describe, expect, it } from "vitest";
import { computeSuggestedPrice } from "./pricing";

describe("computeSuggestedPrice", () => {
  it("folds overhead into material cost, then lands margin on the selling price", () => {
    // 20,000 material + 40% overhead = 28,000 loaded cost; 30% gross margin on price
    // means price = 28,000 / 0.7 = 40,000 (rounded to nearest 10 Rial already).
    expect(
      computeSuggestedPrice({ materialCost: 20_000, overheadRatePercent: 40, marginPercent: 30 }),
    ).toEqual({ loadedCost: 28_000, suggestedPrice: 40_000 });
  });

  it("treats a null overhead rate as zero overhead", () => {
    expect(
      computeSuggestedPrice({ materialCost: 20_000, overheadRatePercent: null, marginPercent: 50 }),
    ).toEqual({ loadedCost: 20_000, suggestedPrice: 40_000 });
  });

  it("returns a null suggested price when no margin is configured, but still reports loaded cost", () => {
    expect(
      computeSuggestedPrice({ materialCost: 20_000, overheadRatePercent: 40, marginPercent: null }),
    ).toEqual({ loadedCost: 28_000, suggestedPrice: null });
  });

  it("rounds the suggested price to the nearest Toman (10 Rial)", () => {
    const { suggestedPrice } = computeSuggestedPrice({ materialCost: 12_345, overheadRatePercent: 0, marginPercent: 33 });
    expect(suggestedPrice).toBe(Math.round(12_345 / 0.67 / 10) * 10);
  });

  it("is zero throughout for a zero material cost", () => {
    expect(computeSuggestedPrice({ materialCost: 0, overheadRatePercent: 25, marginPercent: 20 })).toEqual({
      loadedCost: 0,
      suggestedPrice: 0,
    });
  });
});
