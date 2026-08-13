import { describe, expect, it } from "vitest";
import { reconcileTotals } from "./reconciliation";

describe("reconcileTotals", () => {
  it("reports in-balance when remote and local totals match", () => {
    const result = reconcileTotals({
      remoteOrderCount: 3,
      remoteTotalRial: 1_500_000n,
      localOrderCount: 3,
      localTotalRial: 1_500_000n,
    });
    expect(result.differenceRial).toBe(0n);
    expect(result.inBalance).toBe(true);
  });

  it("reports the shortfall when local is less than remote", () => {
    const result = reconcileTotals({
      remoteOrderCount: 3,
      remoteTotalRial: 1_500_000n,
      localOrderCount: 2,
      localTotalRial: 1_000_000n,
    });
    expect(result.differenceRial).toBe(500_000n);
    expect(result.inBalance).toBe(false);
  });

  it("reports a surplus when local exceeds remote", () => {
    const result = reconcileTotals({
      remoteOrderCount: 2,
      remoteTotalRial: 1_000_000n,
      localOrderCount: 3,
      localTotalRial: 1_500_000n,
    });
    expect(result.differenceRial).toBe(-500_000n);
    expect(result.inBalance).toBe(false);
  });
});
