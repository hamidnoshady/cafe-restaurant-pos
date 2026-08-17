import { describe, expect, it } from "vitest";
import { computeBuyBack, validateBuyBackInput } from "./gold-buyback";

describe("computeBuyBack", () => {
  it("deducts کسری and multiplies by the buy rate", () => {
    // 10g gross, 2% deduction → 9.8g net; buy rate 5,000,000 Rial/g → 49,000,000.
    const result = computeBuyBack({ grossWeight: "10", karsorPercent: 2, buyPricePerGram: 5_000_000 });
    expect(result.netWeight).toBe("9.8");
    expect(result.valueRial).toBe(49_000_000);
  });

  it("handles a zero deduction", () => {
    const result = computeBuyBack({ grossWeight: "5.5", karsorPercent: 0, buyPricePerGram: 2_000_000 });
    expect(result.netWeight).toBe("5.5");
    expect(result.valueRial).toBe(11_000_000);
  });
});

describe("validateBuyBackInput", () => {
  it("accepts a valid input", () => {
    expect(validateBuyBackInput({ grossWeight: "10", karsorPercent: 2, buyPricePerGram: 5_000_000 })).toEqual([]);
  });

  it("rejects bad weight, کسری, or buy rate", () => {
    expect(validateBuyBackInput({ grossWeight: "0", karsorPercent: 2, buyPricePerGram: 5_000_000 }).length).toBeGreaterThan(0);
    expect(validateBuyBackInput({ grossWeight: "10", karsorPercent: 101, buyPricePerGram: 5_000_000 }).length).toBeGreaterThan(0);
    expect(validateBuyBackInput({ grossWeight: "10", karsorPercent: 2, buyPricePerGram: 0 }).length).toBeGreaterThan(0);
  });
});
