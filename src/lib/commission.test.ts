import { describe, expect, it } from "vitest";
import { computeCommissionAccrual, resolveCommissionRule, totalCommission, type CommissionRule } from "./commission";

const line = (over: Partial<Parameters<typeof computeCommissionAccrual>[0]> = {}) => ({
  net: 100_000,
  cost: 40_000,
  itemId: "item-a",
  brandId: "brand-x",
  categoryId: "cat-1",
  ...over,
});

describe("computeCommissionAccrual", () => {
  it("accrues nothing with no matching rule", () => {
    const result = computeCommissionAccrual(line(), [
      { id: "r", kind: "percent", value: 5, basis: "net", itemIds: ["other"] },
    ]);
    expect(result).toEqual({ amount: 0, ruleId: null });
  });

  it("accrues a percent of net exactly", () => {
    const result = computeCommissionAccrual(line(), [{ id: "r", kind: "percent", value: 5, basis: "net" }]);
    expect(result).toEqual({ amount: 5_000, ruleId: "r" });
  });

  it("accrues a margin basis using the line's cost", () => {
    // net 100,000 − cost 40,000 = 60,000 margin; 10% = 6,000.
    const result = computeCommissionAccrual(line(), [{ id: "r", kind: "percent", value: 10, basis: "margin" }]);
    expect(result).toEqual({ amount: 6_000, ruleId: "r" });
  });

  it("accrues nothing on a zero or negative margin", () => {
    const result = computeCommissionAccrual(line({ net: 30_000, cost: 40_000 }), [
      { id: "r", kind: "percent", value: 10, basis: "margin" },
    ]);
    expect(result).toEqual({ amount: 0, ruleId: "r" });
  });

  it("computes a discounted line on its post-discount net", () => {
    const result = computeCommissionAccrual(line({ net: 70_000, cost: 40_000 }), [
      { id: "r", kind: "percent", value: 10, basis: "net" },
    ]);
    expect(result.amount).toBe(7_000);
  });

  it("clamps a fixed amount to the basis", () => {
    const result = computeCommissionAccrual(line({ net: 5_000 }), [
      { id: "r", kind: "fixed", value: 50_000, basis: "net" },
    ]);
    expect(result.amount).toBe(5_000);
  });
});

describe("resolveCommissionRule", () => {
  const rules: CommissionRule[] = [
    { id: "all", kind: "percent", value: 1, basis: "net" },
    { id: "brand", kind: "percent", value: 2, basis: "net", brandIds: ["brand-x"] },
    { id: "item", kind: "percent", value: 3, basis: "net", itemIds: ["item-a"] },
  ];

  it("picks the most specific matching rule: item beats brand beats all", () => {
    expect(resolveCommissionRule(line(), rules)?.id).toBe("item");
    expect(resolveCommissionRule(line({ itemId: "other" }), rules)?.id).toBe("brand");
    expect(resolveCommissionRule(line({ itemId: "other", brandId: "other" }), rules)?.id).toBe("all");
  });

  it("breaks a specificity tie by priority then id", () => {
    const tied: CommissionRule[] = [
      { id: "low", kind: "percent", value: 5, basis: "net", brandIds: ["brand-x"], priority: 1 },
      { id: "high", kind: "percent", value: 5, basis: "net", brandIds: ["brand-x"], priority: 9 },
    ];
    expect(resolveCommissionRule(line(), tied)?.id).toBe("high");
  });
});

describe("totalCommission", () => {
  it("sums accruals", () => {
    expect(totalCommission([{ amount: 1000, ruleId: "a" }, { amount: 2000, ruleId: "b" }])).toBe(3000);
  });
});
