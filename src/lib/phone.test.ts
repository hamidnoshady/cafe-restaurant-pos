import { describe, it, expect } from "vitest";
import { normalizePhone } from "./phone";

describe("phone normalization", () => {
  it("normalizes standard formats to +98", () => {
    expect(normalizePhone("09123456789")).toBe("+989123456789");
    expect(normalizePhone("989123456789")).toBe("+989123456789");
    expect(normalizePhone("+989123456789")).toBe("+989123456789");
    expect(normalizePhone("00989123456789")).toBe("+989123456789");
    expect(normalizePhone("9123456789")).toBe("+989123456789");
  });

  it("handles formatting characters", () => {
    expect(normalizePhone("0912-345-6789")).toBe("+989123456789");
    expect(normalizePhone("(0912) 345 67 89")).toBe("+989123456789");
  });

  it("handles Persian digits", () => {
    expect(normalizePhone("۰۹۱۲۳۴۵۶۷۸۹")).toBe("+989123456789");
    expect(normalizePhone("+۹۸۹۱۲۳۴۵۶۷۸۹")).toBe("+989123456789");
  });

  it("handles Arabic digits", () => {
    expect(normalizePhone("٠٩١٢٣٤٥٦٧٨٩")).toBe("+989123456789");
  });

  it("rejects invalid lengths", () => {
    expect(normalizePhone("0912345678")).toBeNull();
    expect(normalizePhone("091234567890")).toBeNull();
  });
});
