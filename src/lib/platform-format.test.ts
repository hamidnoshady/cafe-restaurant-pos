import { describe, it, expect } from "vitest";
import { fmtDate, fmtDateTime, fmtRelative, fmtToman, fmtBytes, fmtPercent } from "./platform-format";

describe("platform-format", () => {
  describe("fmtDate", () => {
    it("renders a Jalali date in Persian digits", () => {
      // 2024-03-20 is 1403-01-01 (Nowruz)
      const out = fmtDate("2024-03-20T12:00:00Z");
      expect(out).toContain("۱۴۰۳");
      expect(out).not.toMatch(/[0-9]/); // no ASCII digits
    });

    it("returns the em-dash placeholder for nullish/blank/invalid input", () => {
      expect(fmtDate(null)).toBe("—");
      expect(fmtDate(undefined)).toBe("—");
      expect(fmtDate("")).toBe("—");
      expect(fmtDate("not-a-date")).toBe("—");
    });

    it("includes the clock when withTime is set", () => {
      const dateOnly = fmtDate("2024-03-20T09:05:00Z");
      const withTime = fmtDateTime("2024-03-20T09:05:00Z");
      expect(withTime.length).toBeGreaterThan(dateOnly.length);
    });
  });

  describe("fmtRelative", () => {
    it("reads «همین حالا» for very recent and future timestamps", () => {
      expect(fmtRelative(new Date())).toBe("همین حالا");
      expect(fmtRelative(new Date(Date.now() + 60_000))).toBe("همین حالا");
    });

    it("uses minute/hour/day labels within the week", () => {
      expect(fmtRelative(new Date(Date.now() - 5 * 60_000))).toContain("دقیقه پیش");
      expect(fmtRelative(new Date(Date.now() - 3 * 3600_000))).toContain("ساعت پیش");
      expect(fmtRelative(new Date(Date.now() - 2 * 86_400_000))).toContain("روز پیش");
    });

    it("falls back to an absolute Jalali date past a week", () => {
      expect(fmtRelative(new Date(Date.now() - 30 * 86_400_000))).toContain("۱۴");
    });

    it("returns the placeholder for nullish input", () => {
      expect(fmtRelative(null)).toBe("—");
    });
  });

  describe("fmtToman", () => {
    it("converts Rial to Toman with the unit and Persian digits", () => {
      expect(fmtToman(1_250_000)).toContain("تومان");
      expect(fmtToman(1_250_000)).toContain("۱۲۵");
    });

    it("can omit the unit", () => {
      expect(fmtToman(1_000_000, { withUnit: false })).not.toContain("تومان");
    });

    it("returns the placeholder for nullish/non-numeric input", () => {
      expect(fmtToman(null)).toBe("—");
      expect(fmtToman(undefined)).toBe("—");
      expect(fmtToman("abc")).toBe("—");
    });
  });

  describe("fmtBytes", () => {
    it("scales through units", () => {
      expect(fmtBytes(512)).toContain("بایت");
      expect(fmtBytes(2048)).toContain("کیلوبایت");
      expect(fmtBytes(5 * 1024 * 1024)).toContain("مگابایت");
      expect(fmtBytes(3 * 1024 * 1024 * 1024)).toContain("گیگابایت");
    });

    it("returns the placeholder for nullish input", () => {
      expect(fmtBytes(null)).toBe("—");
      expect(fmtBytes(undefined)).toBe("—");
    });
  });

  describe("fmtPercent", () => {
    it("renders Persian digits with the percent sign", () => {
      expect(fmtPercent(98)).toBe("۹۸٪");
    });

    it("supports decimals", () => {
      expect(fmtPercent(12.34, 1)).toBe("۱۲٫۳٪".replace("٫", "٫")); // fa decimal
    });

    it("returns the placeholder for nullish input", () => {
      expect(fmtPercent(null)).toBe("—");
    });
  });
});
