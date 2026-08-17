import { describe, expect, it } from "vitest";
import { predictNextPurchase } from "./repurchase";

describe("predictNextPurchase", () => {
  it("predicts nothing from a single purchase", () => {
    const prediction = predictNextPurchase({ dates: ["2026-06-01"] });
    expect(prediction.purchaseCount).toBe(1);
    expect(prediction.nextPurchaseDate).toBeNull();
    expect(prediction.reliable).toBe(false);
  });

  it("predicts a regular cadence", () => {
    const prediction = predictNextPurchase({
      dates: ["2026-01-01", "2026-01-31", "2026-03-02", "2026-04-01"],
    });
    // Every gap is 30 days → median 30, confidence 1.
    expect(prediction.avgIntervalDays).toBe(30);
    expect(prediction.confidence).toBe(1);
    expect(prediction.reliable).toBe(true);
    expect(prediction.nextPurchaseDate).toBe("2026-05-01");
  });

  it("suppresses an erratic cadence as low confidence", () => {
    const prediction = predictNextPurchase({
      dates: ["2026-01-01", "2026-01-06", "2026-02-15", "2026-02-18"],
    });
    // Gaps 5, 40, 3 → spread dominates the median → confidence collapses.
    expect(prediction.reliable).toBe(false);
    expect(prediction.nextPurchaseDate).toBeNull();
    expect(prediction.confidence).toBeLessThan(0.5);
  });

  it("deduplicates same-day purchases and skips zero-length gaps", () => {
    const prediction = predictNextPurchase({
      dates: ["2026-01-01", "2026-01-01", "2026-02-01", "2026-03-01"],
    });
    expect(prediction.purchaseCount).toBe(3);
    expect(prediction.avgIntervalDays).toBe(30);
    expect(prediction.reliable).toBe(true);
  });
});
