import { describe, expect, it } from "vitest";
import {
  accessoryCogs,
  computeAccessorySalePrice,
  nextAverageUnitCost,
  validateAccessorySalePriceInput,
  validateStockReceipt,
} from "./accessories";

describe("nextAverageUnitCost", () => {
  it("is the incoming cost when there is no prior stock", () => {
    expect(nextAverageUnitCost("0", null, "10", 50_000)).toBe("50000");
    expect(nextAverageUnitCost("0", 90_000, "10", 50_000)).toBe("50000");
  });

  it("rolls the average forward, weighted by quantity", () => {
    // 10 @ 50,000 + 10 @ 70,000 = 20 @ 60,000
    expect(nextAverageUnitCost("10", 50_000, "10", 70_000)).toBe("60000");
    // 30 @ 50,000 + 10 @ 90,000 = 40 @ 60,000
    expect(nextAverageUnitCost("30", 50_000, "10", 90_000)).toBe("60000");
  });

  it("rounds the new average to whole Rial", () => {
    // (3 * 100 + 1 * 101) / 4 = 100.25 -> 100
    expect(nextAverageUnitCost("3", 100, "1", 101)).toBe("100");
  });

  it("ignores a prior cost recorded against zero stock", () => {
    expect(nextAverageUnitCost("0", 1_000_000, "5", 20_000)).toBe("20000");
  });
});

describe("computeAccessorySalePrice", () => {
  it("multiplies out the line and adds VAT on the net", () => {
    expect(computeAccessorySalePrice({ unitPrice: 250_000, quantity: "4", vatPercent: 9 })).toEqual({
      gross: "1000000",
      discount: "0",
      net: "1000000",
      vat: "90000",
      total: "1090000",
    });
  });

  it("takes VAT after the discount, and the components always sum to the total", () => {
    const breakdown = computeAccessorySalePrice({
      unitPrice: 333_333,
      quantity: "3",
      discount: 99_999,
      vatPercent: 9,
    });
    expect(breakdown.gross).toBe("999999");
    expect(breakdown.net).toBe("900000");
    expect(breakdown.vat).toBe("81000");
    expect(BigInt(breakdown.net) + BigInt(breakdown.vat)).toBe(BigInt(breakdown.total));
  });

  it("refuses a discount larger than the line", () => {
    expect(() =>
      computeAccessorySalePrice({ unitPrice: 100, quantity: "1", discount: 200, vatPercent: 0 }),
    ).toThrow();
  });

  it("rejects a non-positive price or quantity and an out-of-range VAT rate", () => {
    expect(validateAccessorySalePriceInput({ unitPrice: 0, quantity: "1", vatPercent: 9 }).length).toBe(1);
    expect(validateAccessorySalePriceInput({ unitPrice: 100, quantity: "0", vatPercent: 9 }).length).toBe(1);
    expect(validateAccessorySalePriceInput({ unitPrice: 100, quantity: "1", vatPercent: 101 }).length).toBe(1);
  });
});

describe("accessoryCogs", () => {
  it("is quantity × carrying cost, rounded", () => {
    expect(accessoryCogs("4", 60_000)).toBe("240000");
    expect(accessoryCogs("3", 100)).toBe("300");
  });
});

describe("validateStockReceipt", () => {
  it("accepts a positive quantity with a whole-Rial cost", () => {
    expect(validateStockReceipt({ quantity: "12", unitCost: 50_000 })).toEqual([]);
  });

  it("rejects a non-positive quantity and a fractional cost", () => {
    expect(validateStockReceipt({ quantity: "0", unitCost: 50_000 }).length).toBe(1);
    expect(validateStockReceipt({ quantity: "abc", unitCost: 50_000 }).length).toBe(1);
    expect(validateStockReceipt({ quantity: "1", unitCost: 1.5 }).length).toBe(1);
  });
});
