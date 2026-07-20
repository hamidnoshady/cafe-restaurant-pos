import { describe, expect, it } from "vitest";
import {
  formatPersianNumber,
  groupDigits,
  toLatinDigits,
  toPersianDigits,
} from "./digits";

describe("digits", () => {
  it("converts ASCII to Persian digits", () => {
    expect(toPersianDigits(1234567890)).toBe("۱۲۳۴۵۶۷۸۹۰");
    expect(toPersianDigits("سفارش 42")).toBe("سفارش ۴۲");
  });

  it("converts Persian and Arabic-Indic digits back to ASCII", () => {
    expect(toLatinDigits("۱۲۳۴")).toBe("1234");
    expect(toLatinDigits("٥٦٧")).toBe("567");
    expect(toLatinDigits("mixed ۱2٣")).toBe("mixed 123");
  });

  it("round-trips", () => {
    expect(toLatinDigits(toPersianDigits("9876543210"))).toBe("9876543210");
  });

  it("groups thousands", () => {
    expect(groupDigits(1250000)).toBe("1٬250٬000");
    expect(groupDigits(-42000)).toBe("-42٬000");
    expect(groupDigits(999)).toBe("999");
    expect(groupDigits(12345678901234567890n)).toBe("12٬345٬678٬901٬234٬567٬890");
  });

  it("formats grouped Persian numbers", () => {
    expect(formatPersianNumber(1250000)).toBe("۱٬۲۵۰٬۰۰۰");
  });
});
