import { describe, expect, it } from "vitest";
import { holooAmountToRial, rialScaleForUnit, rialToHolooAmount } from "./holoo-money";

describe("rialScaleForUnit", () => {
  it("Toman is 10 Rial, Rial is 1", () => {
    expect(rialScaleForUnit("toman")).toBe(10n);
    expect(rialScaleForUnit("rial")).toBe(1n);
  });
});

describe("holooAmountToRial", () => {
  it("converts whole Toman to Rial exactly", () => {
    expect(holooAmountToRial("1200", "toman")).toBe(12000n);
  });
  it("rounds a fractional Toman half-up", () => {
    expect(holooAmountToRial("12.5", "toman")).toBe(125n);
    expect(holooAmountToRial("12.49", "toman")).toBe(125n);
    expect(holooAmountToRial("12.51", "toman")).toBe(125n);
  });
  it("leaves Rial unchanged", () => {
    expect(holooAmountToRial("12345", "rial")).toBe(12345n);
  });
  it("accepts a number without float corruption", () => {
    expect(holooAmountToRial(12.5, "toman")).toBe(125n);
  });
  it("rejects malformed input", () => {
    expect(() => holooAmountToRial("abc", "toman")).toThrow(/invalid_holoo_amount/);
  });
});

describe("rialToHolooAmount", () => {
  it("divides by 10 for Toman, dropping trailing zero", () => {
    expect(rialToHolooAmount(12000n, "toman")).toBe("1200");
    expect(rialToHolooAmount(12005n, "toman")).toBe("1200.5");
  });
  it("keeps Rial unchanged", () => {
    expect(rialToHolooAmount(12345n, "rial")).toBe("12345");
  });
  it("rejects negatives", () => {
    expect(() => rialToHolooAmount(-1n, "rial")).toThrow(/negative_rial/);
  });
});
