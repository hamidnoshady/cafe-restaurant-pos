import { describe, expect, it } from "vitest";
import {
  compareUnsignedDecimalText,
  validateCountText,
  validateMoneyText,
  validatePercentageText,
  validatePositiveDecimalText,
  validateQuantityText,
} from "./numeric-validation";

describe("canonical numeric validation", () => {
  it("validates positive decimals exactly and enforces precision", () => {
    expect(validatePositiveDecimalText("12.5", 9).valid).toBe(true);
    expect(validatePositiveDecimalText("0.100000001", 9).valid).toBe(true);
    expect(validatePositiveDecimalText("0", 9).code).toBe("positive_required");
    expect(validatePositiveDecimalText("-1", 9).code).toBe("invalid");
    expect(validatePositiveDecimalText("-0", 9).code).toBe("invalid");
    expect(validatePositiveDecimalText("1.1234567890", 9).code).toBe("precision_exceeded");
    expect(validatePositiveDecimalText("1e5", 9).code).toBe("invalid");
    expect(validatePositiveDecimalText("12abc", 9).code).toBe("invalid");
  });

  it("uses the inventory quantity contract", () => {
    expect(validateQuantityText("2030").valid).toBe(true);
    expect(validateQuantityText("12.123456789").valid).toBe(true);
    expect(validateQuantityText("00").valid).toBe(false);
    expect(validateQuantityText("12.").valid).toBe(false);
  });

  it("rejects fractions for count fields instead of truncating them", () => {
    expect(validateCountText("12").valid).toBe(true);
    expect(validateCountText("0").code).toBe("positive_required");
    expect(validateCountText("12.9").code).toBe("integer_required");
  });

  it("constrains percentages to zero through one hundred", () => {
    expect(validatePercentageText("0").valid).toBe(true);
    expect(validatePercentageText("99.9999").valid).toBe(true);
    expect(validatePercentageText("100.0").valid).toBe(true);
    expect(validatePercentageText("100.01").code).toBe("percentage_range");
    expect(validatePercentageText("101").code).toBe("percentage_range");
  });

  it("keeps large Rial values exact and bounded to PostgreSQL bigint", () => {
    expect(validateMoneyText("1000000000").valid).toBe(true);
    expect(validateMoneyText("9007199254740993").valid).toBe(true);
    expect(validateMoneyText("9223372036854775807").valid).toBe(true);
    expect(validateMoneyText("9223372036854775808").code).toBe("rial_range");
    expect(validateMoneyText("1.5").code).toBe("integer_required");
  });

  it("compares decimal text without IEEE-754 conversion", () => {
    expect(compareUnsignedDecimalText("9007199254740993", "9007199254740992")).toBe(1);
    expect(compareUnsignedDecimalText("12.500", "12.5")).toBe(0);
    expect(compareUnsignedDecimalText("0.100000001", "0.1")).toBe(1);
  });
});
