import { describe, expect, it } from "vitest";
import { computeGoldSalePrice, validateGoldSalePriceInput, type GoldSalePriceInput } from "./gold-pricing";

const base: GoldSalePriceInput = {
  netWeight: "2.5",
  pricePerGram: 5_000_000,
  makingCharge: { type: "percent", value: 7 },
  profitPercent: 10,
  vatPercent: 9,
};

describe("computeGoldSalePrice", () => {
  it("computes the standard formula: metal value, percent making charge, profit on (metal+making charge), VAT on (making charge+profit) only", () => {
    const breakdown = computeGoldSalePrice(base);
    // metalValue = 2.5 * 5,000,000 = 12,500,000
    expect(breakdown.metalValue).toBe("12500000");
    // makingCharge = 12,500,000 * 7% = 875,000
    expect(breakdown.makingCharge).toBe("875000");
    // profit = (12,500,000 + 875,000) * 10% = 1,337,500
    expect(breakdown.profit).toBe("1337500");
    // vat = (875,000 + 1,337,500) * 9% = 199,125 -- metal value excluded
    expect(breakdown.vat).toBe("199125");
    // total = 12,500,000 + 875,000 + 1,337,500 + 199,125
    expect(breakdown.total).toBe("14911625");
  });

  it("the breakdown's components always sum exactly to the total (no independent rounding drift)", () => {
    const breakdown = computeGoldSalePrice({ ...base, netWeight: "1.111111111", vatPercent: 9.4 });
    const sum =
      Number(breakdown.metalValue) + Number(breakdown.makingCharge) + Number(breakdown.profit) + Number(breakdown.vat);
    expect(sum).toBe(Number(breakdown.total));
  });

  it("VAT excludes metal value: a zero making-charge and zero profit produces zero VAT even with metal value present", () => {
    const breakdown = computeGoldSalePrice({
      ...base,
      makingCharge: { type: "percent", value: 0 },
      profitPercent: 0,
      vatPercent: 9,
    });
    expect(breakdown.metalValue).toBe("12500000");
    expect(breakdown.vat).toBe("0");
    expect(breakdown.total).toBe("12500000");
  });

  it("supports a fixed making charge instead of a percent", () => {
    const breakdown = computeGoldSalePrice({
      netWeight: "1",
      pricePerGram: 5_000_000,
      makingCharge: { type: "fixed", value: 300_000 },
      profitPercent: 0,
      vatPercent: 9,
    });
    expect(breakdown.metalValue).toBe("5000000");
    expect(breakdown.makingCharge).toBe("300000");
    expect(breakdown.profit).toBe("0");
    // vat = 300,000 * 9% = 27,000
    expect(breakdown.vat).toBe("27000");
    expect(breakdown.total).toBe("5327000");
  });

  it("rounds each component half-up to whole Rial as it's computed", () => {
    const breakdown = computeGoldSalePrice({
      netWeight: "1",
      pricePerGram: 1,
      makingCharge: { type: "percent", value: 50 }, // 1 * 0.5 = 0.5 -> rounds to 1
      profitPercent: 0,
      vatPercent: 0,
    });
    expect(breakdown.metalValue).toBe("1");
    expect(breakdown.makingCharge).toBe("1");
  });

  it("throws (does not silently compute a wrong price) for invalid input", () => {
    expect(() => computeGoldSalePrice({ ...base, netWeight: "0" })).toThrow();
    expect(() => computeGoldSalePrice({ ...base, pricePerGram: 0 })).toThrow();
    expect(() => computeGoldSalePrice({ ...base, pricePerGram: 1.5 })).toThrow();
    expect(() => computeGoldSalePrice({ ...base, profitPercent: 101 })).toThrow();
    expect(() => computeGoldSalePrice({ ...base, vatPercent: -1 })).toThrow();
  });
});

describe("validateGoldSalePriceInput", () => {
  it("accepts well-formed input", () => {
    expect(validateGoldSalePriceInput(base)).toHaveLength(0);
  });

  it("rejects a non-positive net weight", () => {
    expect(validateGoldSalePriceInput({ ...base, netWeight: "0" }).length).toBeGreaterThan(0);
    expect(validateGoldSalePriceInput({ ...base, netWeight: "-1" }).length).toBeGreaterThan(0);
  });

  it("rejects a non-integer or non-positive price per gram", () => {
    expect(validateGoldSalePriceInput({ ...base, pricePerGram: 0 }).length).toBeGreaterThan(0);
    expect(validateGoldSalePriceInput({ ...base, pricePerGram: 1.5 }).length).toBeGreaterThan(0);
    expect(validateGoldSalePriceInput({ ...base, pricePerGram: -5 }).length).toBeGreaterThan(0);
  });

  it("rejects an out-of-range percent making charge but allows any non-negative fixed amount", () => {
    expect(
      validateGoldSalePriceInput({ ...base, makingCharge: { type: "percent", value: 101 } }).length,
    ).toBeGreaterThan(0);
    expect(
      validateGoldSalePriceInput({ ...base, makingCharge: { type: "fixed", value: -1 } }).length,
    ).toBeGreaterThan(0);
    expect(
      validateGoldSalePriceInput({ ...base, makingCharge: { type: "fixed", value: 10_000_000 } }),
    ).toHaveLength(0);
  });

  it("rejects out-of-range profit or VAT percents", () => {
    expect(validateGoldSalePriceInput({ ...base, profitPercent: -1 }).length).toBeGreaterThan(0);
    expect(validateGoldSalePriceInput({ ...base, profitPercent: 101 }).length).toBeGreaterThan(0);
    expect(validateGoldSalePriceInput({ ...base, vatPercent: -1 }).length).toBeGreaterThan(0);
    expect(validateGoldSalePriceInput({ ...base, vatPercent: 101 }).length).toBeGreaterThan(0);
  });
});
