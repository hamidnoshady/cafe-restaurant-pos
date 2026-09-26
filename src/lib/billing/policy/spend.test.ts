import { describe, expect, it } from "vitest";
import { evaluateSpend } from "./spend";

describe("evaluateSpend", () => {
  it("does not block when there is no budget", () => {
    const result = evaluateSpend({
      spentRial: 1_000_000,
      budgetRial: null,
      thresholds: [50, 100],
      action: "block_noncritical",
      critical: false,
    });
    expect(result.blocked).toBe(false);
  });

  it("blocks non-critical usage at the limit and leaves critical usage available", () => {
    const shared = {
      spentRial: 100,
      budgetRial: 100,
      thresholds: [50, 75, 90, 100],
      action: "block_noncritical" as const,
    };
    expect(evaluateSpend({ ...shared, critical: false }).blocked).toBe(true);
    expect(evaluateSpend({ ...shared, critical: true }).blocked).toBe(false);
  });

  it("warn-only never blocks", () => {
    expect(
      evaluateSpend({
        spentRial: 200,
        budgetRial: 100,
        thresholds: [100],
        action: "warn_only",
        critical: false,
      }).blocked,
    ).toBe(false);
  });
});
