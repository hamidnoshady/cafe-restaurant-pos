import { describe, expect, it } from "vitest";
import {
  computeCosmeticSalePrice,
  cosmeticCogs,
  nextAverageUnitCost,
  unitPriceFromPack,
  validateStockReceipt,
} from "./cosmetics";

describe("unitPriceFromPack", () => {
  it("divides a pack price by the number of units, rounded to the Rial", () => {
    expect(unitPriceFromPack(1000, 3)).toBe("333"); // 333.33… → 333
    expect(unitPriceFromPack(1000, 2)).toBe("500");
  });

  it("rejects non-positive or fractional inputs", () => {
    expect(() => unitPriceFromPack(0, 3)).toThrow();
    expect(() => unitPriceFromPack(1000, 0)).toThrow();
    expect(() => unitPriceFromPack(1000.5, 3)).toThrow();
    expect(() => unitPriceFromPack(1000, 1.5)).toThrow();
  });
});

describe("computeCosmeticSalePrice", () => {
  it("computes gross, discount, net, VAT and total exactly", () => {
    const breakdown = computeCosmeticSalePrice({
      unitPrice: 250_000,
      quantity: "3",
      discount: 50_000,
      vatPercent: 9,
    });
    expect(breakdown.gross).toBe("750000");
    expect(breakdown.discount).toBe("50000");
    expect(breakdown.net).toBe("700000");
    expect(breakdown.vat).toBe("63000");
    expect(breakdown.total).toBe("763000");
  });

  it("rounds each stage to the whole Rial", () => {
    const breakdown = computeCosmeticSalePrice({
      unitPrice: 111_111,
      quantity: "1.5",
      discount: 0,
      vatPercent: 9,
    });
    // gross = 111111 × 1.5 = 166666.5 → 166667
    expect(breakdown.gross).toBe("166667");
    // vat = 166667 × 9% = 15000.03 → 15000
    expect(breakdown.vat).toBe("15000");
    expect(breakdown.total).toBe("181667");
  });

  it("refuses a discount greater than the line gross", () => {
    expect(() =>
      computeCosmeticSalePrice({ unitPrice: 1000, quantity: "1", discount: 1001, vatPercent: 9 }),
    ).toThrow("تخفیف");
  });

  it("validates inputs with Persian errors", () => {
    expect(() =>
      computeCosmeticSalePrice({ unitPrice: -5, quantity: "1", vatPercent: 9 }),
    ).toThrow();
    expect(() => computeCosmeticSalePrice({ unitPrice: 1000, quantity: "0", vatPercent: 9 })).toThrow();
    expect(() =>
      computeCosmeticSalePrice({ unitPrice: 1000, quantity: "1", vatPercent: 101 }),
    ).toThrow();
  });
});

describe("cosmeticCogs", () => {
  it("is quantity × unit cost, rounded", () => {
    expect(cosmeticCogs("3", 100_000)).toBe("300000");
    expect(cosmeticCogs("1.5", 111_111)).toBe("166667");
  });
});

describe("shared receipt helpers", () => {
  it("nextAverageUnitCost rolls a running weighted average forward", () => {
    expect(nextAverageUnitCost("10", 1000, "5", 2000)).toBe("1333");
    expect(nextAverageUnitCost("0", null, "4", 1500)).toBe("1500");
  });

  it("validateStockReceipt rejects empty or negative quantities", () => {
    expect(validateStockReceipt({ quantity: "5", unitCost: 1000 })).toEqual([]);
    expect(validateStockReceipt({ quantity: "0", unitCost: 1000 }).length).toBeGreaterThan(0);
    expect(validateStockReceipt({ quantity: "5", unitCost: -1 }).length).toBeGreaterThan(0);
  });
});
