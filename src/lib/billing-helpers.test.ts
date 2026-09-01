import { describe, expect, it } from "vitest";
import { n, positiveInt } from "./billing-helpers";

describe("billing numeric helpers", () => {
  describe("n", () => {
    it("coerces numeric strings (the shape pg returns for bigint)", () => {
      expect(n("12345")).toBe(12345);
      expect(n("0")).toBe(0);
    });
    it("passes through finite numbers", () => {
      expect(n(99)).toBe(99);
    });
    it("turns null/undefined/NaN/Infinity into 0", () => {
      expect(n(null)).toBe(0);
      expect(n(undefined)).toBe(0);
      expect(n(Number.NaN)).toBe(0);
      expect(n(Number.POSITIVE_INFINITY)).toBe(0);
      expect(n("not-a-number")).toBe(0);
    });
  });

  describe("positiveInt", () => {
    it("accepts only strictly positive safe integers", () => {
      expect(positiveInt(1)).toBe(true);
      expect(positiveInt(1_000_000)).toBe(true);
      expect(positiveInt(0)).toBe(false);
      expect(positiveInt(-5)).toBe(false);
      expect(positiveInt(1.5)).toBe(false);
      expect(positiveInt(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    });
  });
});
