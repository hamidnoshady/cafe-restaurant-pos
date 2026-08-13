import { describe, expect, it } from "vitest";
import { rialToWooAmount, wooAmountToRial } from "./woo-money";

describe("wooAmountToRial", () => {
  it("multiplies Toman by 10", () => {
    expect(wooAmountToRial("15000", "toman")).toBe(150000n);
    expect(wooAmountToRial("15000.5", "toman")).toBe(150005n);
    expect(wooAmountToRial(15000, "toman")).toBe(150000n);
  });

  it("keeps Rial unchanged", () => {
    expect(wooAmountToRial("150000", "rial")).toBe(150000n);
    expect(wooAmountToRial("150000.0", "rial")).toBe(150000n);
  });

  it("rounds fractional Rial half-up", () => {
    expect(wooAmountToRial("1.5", "toman")).toBe(15n);
    expect(wooAmountToRial("0.5", "toman")).toBe(5n);
    expect(wooAmountToRial("0.4", "toman")).toBe(4n);
    // .005 Toman = 0.05 Rial → rounds to 0
    expect(wooAmountToRial("1.005", "toman")).toBe(10n);
    expect(wooAmountToRial("1.006", "toman")).toBe(10n);
    expect(wooAmountToRial("1.05", "toman")).toBe(11n);
  });

  it("rejects non-numeric input", () => {
    expect(() => wooAmountToRial("", "toman")).toThrow(/invalid_woo_amount/);
    expect(() => wooAmountToRial("12x", "toman")).toThrow(/invalid_woo_amount/);
    expect(() => wooAmountToRial("-5", "toman")).toThrow(/invalid_woo_amount/);
    expect(() => wooAmountToRial("1.2.3", "toman")).toThrow(/invalid_woo_amount/);
  });
});

describe("rialToWooAmount", () => {
  it("divides Rial by 10 for Toman, keeping only needed precision", () => {
    expect(rialToWooAmount(150000n, "toman")).toBe("15000");
    expect(rialToWooAmount(150005n, "toman")).toBe("15000.5");
    expect(rialToWooAmount("150000", "toman")).toBe("15000");
  });

  it("returns Rial unchanged for Rial", () => {
    expect(rialToWooAmount(150000n, "rial")).toBe("150000");
  });

  it("rejects negatives", () => {
    expect(() => rialToWooAmount(-1n, "toman")).toThrow(/negative_rial/);
  });

  it("round-trips through conversion", () => {
    for (const unit of ["toman", "rial"] as const) {
      for (const amount of ["0", "1", "999.9", "123456.7"]) {
        const rial = wooAmountToRial(amount, unit);
        expect(wooAmountToRial(rialToWooAmount(rial, unit), unit)).toBe(rial);
      }
    }
  });
});
