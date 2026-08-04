import { describe, expect, it } from "vitest";
import { isPurity, validateGoldPrice, validateStone, validateWeightAttributes } from "./gold";

describe("isPurity", () => {
  it("accepts the known purities", () => {
    expect(isPurity("18")).toBe(true);
    expect(isPurity("21")).toBe(true);
    expect(isPurity("24")).toBe(true);
  });

  it("rejects anything else, including coin denominations", () => {
    expect(isPurity("coin")).toBe(false);
    expect(isPurity("22")).toBe(false);
    expect(isPurity("")).toBe(false);
  });
});

describe("validateWeightAttributes", () => {
  const valid = { purity: "18", grossWeight: "5.250", netWeight: "5.250" };

  it("accepts a well-formed input", () => {
    expect(validateWeightAttributes(valid)).toHaveLength(0);
  });

  it("rejects an unknown purity", () => {
    expect(validateWeightAttributes({ ...valid, purity: "22" }).length).toBeGreaterThan(0);
  });

  it("rejects a zero or negative gross weight", () => {
    expect(validateWeightAttributes({ ...valid, grossWeight: "0" }).length).toBeGreaterThan(0);
    expect(validateWeightAttributes({ ...valid, grossWeight: "-1" }).length).toBeGreaterThan(0);
  });

  it("rejects a zero or negative net weight", () => {
    expect(validateWeightAttributes({ ...valid, netWeight: "0" }).length).toBeGreaterThan(0);
  });

  it("rejects a non-numeric weight", () => {
    expect(validateWeightAttributes({ ...valid, grossWeight: "abc" }).length).toBeGreaterThan(0);
  });

  it("rejects net weight exceeding gross weight", () => {
    expect(
      validateWeightAttributes({ ...valid, grossWeight: "5", netWeight: "6" }).length,
    ).toBeGreaterThan(0);
  });

  it("accepts net weight equal to gross weight (no stones deducted yet)", () => {
    expect(validateWeightAttributes({ ...valid, grossWeight: "5", netWeight: "5" })).toHaveLength(0);
  });
});

describe("validateGoldPrice", () => {
  it("accepts a positive integer price for a known purity", () => {
    expect(validateGoldPrice("18", 5_000_000)).toHaveLength(0);
  });

  it("rejects an unknown purity", () => {
    expect(validateGoldPrice("22", 5_000_000).length).toBeGreaterThan(0);
  });

  it("rejects a zero, negative, or fractional price", () => {
    expect(validateGoldPrice("18", 0).length).toBeGreaterThan(0);
    expect(validateGoldPrice("18", -1).length).toBeGreaterThan(0);
    expect(validateGoldPrice("18", 1.5).length).toBeGreaterThan(0);
  });
});

describe("validateStone", () => {
  const valid = { stoneType: "الماس", carat: "0.5", cost: 20_000_000 };

  it("accepts a well-formed stone", () => {
    expect(validateStone(valid)).toHaveLength(0);
  });

  it("rejects a blank stone type", () => {
    expect(validateStone({ ...valid, stoneType: "" }).length).toBeGreaterThan(0);
    expect(validateStone({ ...valid, stoneType: "   " }).length).toBeGreaterThan(0);
  });

  it("rejects a zero, negative, or non-numeric carat", () => {
    expect(validateStone({ ...valid, carat: "0" }).length).toBeGreaterThan(0);
    expect(validateStone({ ...valid, carat: "-1" }).length).toBeGreaterThan(0);
    expect(validateStone({ ...valid, carat: "abc" }).length).toBeGreaterThan(0);
  });

  it("rejects a zero, negative, or fractional cost", () => {
    expect(validateStone({ ...valid, cost: 0 }).length).toBeGreaterThan(0);
    expect(validateStone({ ...valid, cost: -1 }).length).toBeGreaterThan(0);
    expect(validateStone({ ...valid, cost: 1.5 }).length).toBeGreaterThan(0);
  });
});
