import { describe, expect, it } from "vitest";
import { recipeCostDrift } from "./cost-drift";

describe("recipeCostDrift", () => {
  it("flags a cost that rose past the threshold, with the old and new margin", () => {
    const result = recipeCostDrift({
      currentCost: 120_000,
      referenceCost: 100_000,
      price: 200_000,
      thresholdPercent: 10,
    });
    expect(result.costChangePercent).toBe(20);
    expect(result.drifted).toBe(true);
    expect(result.oldMarginPercent).toBe(50);
    expect(result.newMarginPercent).toBe(40);
  });

  it("does not flag a cost within the threshold", () => {
    const result = recipeCostDrift({
      currentCost: 105_000,
      referenceCost: 100_000,
      price: 200_000,
      thresholdPercent: 10,
    });
    expect(result.drifted).toBe(false);
    expect(result.newMarginPercent).toBeCloseTo(47.5, 5);
  });

  it("treats a rise from a zero reference as an unbounded increase", () => {
    const result = recipeCostDrift({
      currentCost: 1_000,
      referenceCost: 0,
      price: 5_000,
      thresholdPercent: 10,
    });
    expect(result.costChangePercent).toBe(Number.POSITIVE_INFINITY);
    expect(result.drifted).toBe(true);
  });

  it("is not drifted when there is no cost movement at all", () => {
    const result = recipeCostDrift({
      currentCost: 0,
      referenceCost: 0,
      price: 5_000,
      thresholdPercent: 10,
    });
    expect(result.drifted).toBe(false);
  });
});
