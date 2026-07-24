import { describe, expect, it } from "vitest";
import {
  allocateRialByWeight,
  positiveQuantityText,
  proportionalDepletionValue,
  quantityText,
  rialText,
  roundRial,
  unitCostText,
  multiplyExact,
} from "./inventory-exact";

describe("exact inventory arithmetic", () => {
  it("canonicalizes strings and rejects quantity precision above nine places", () => {
    expect(quantityText("0.333333333")).toBe("0.333333333");
    expect(quantityText("12.340000000")).toBe("12.34");
    expect(() => quantityText("0.3333333333")).toThrow("quantity_precision_exceeded");
    expect(() => quantityText("1e3")).toThrow("invalid_quantity");
    expect(() => positiveQuantityText("0")).toThrow("invalid_quantity");
  });

  it("rounds the complete exact value once using half-up", () => {
    const exact = multiplyExact(quantityText("0.333333333"), unitCostText("100"));
    expect(roundRial(exact)).toBe("33");
    expect(roundRial(multiplyExact(quantityText("0.005"), unitCostText("100")))).toBe("1");
  });

  it("allocates a receipt value deterministically and conserves huge Rial totals", () => {
    const total = rialText("900719925474099312345");
    const allocated = allocateRialByWeight(total, [
      { key: "a", weight: quantityText("0.333333333") },
      { key: "b", weight: quantityText("0.333333333") },
      { key: "c", weight: quantityText("0.333333334") },
    ]);
    const sum = [...allocated.values()].reduce((value, part) => value + BigInt(part), 0n);
    expect(sum.toString()).toBe(total);
    expect(BigInt(allocated.get("c")!)).toBeGreaterThanOrEqual(BigInt(allocated.get("a")!));
  });

  it("assigns the final depletion all residual lot value", () => {
    expect(proportionalDepletionValue(quantityText("3"), rialText("100"), quantityText("1"))).toBe("33");
    expect(proportionalDepletionValue(quantityText("2"), rialText("67"), quantityText("2"))).toBe("67");
  });
});
