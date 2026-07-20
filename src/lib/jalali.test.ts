import { describe, expect, it } from "vitest";
import {
  formatJalali,
  isLeapJalaliYear,
  isValidJalaliDate,
  jalaliMonthLength,
  jalaliToIsoDate,
  toGregorian,
  toJalali,
} from "./jalali";

describe("jalali conversion", () => {
  it("converts known dates Gregorian → Jalali", () => {
    expect(toJalali(2024, 3, 20)).toEqual({ jy: 1403, jm: 1, jd: 1 }); // Nowruz 1403
    expect(toJalali(2025, 3, 21)).toEqual({ jy: 1404, jm: 1, jd: 1 }); // Nowruz 1404
    expect(toJalali(2026, 7, 20)).toEqual({ jy: 1405, jm: 4, jd: 29 });
    expect(toJalali(1979, 2, 11)).toEqual({ jy: 1357, jm: 11, jd: 22 });
  });

  it("converts known dates Jalali → Gregorian", () => {
    expect(toGregorian(1403, 1, 1)).toEqual({ gy: 2024, gm: 3, gd: 20 });
    expect(toGregorian(1403, 12, 30)).toEqual({ gy: 2025, gm: 3, gd: 20 }); // 1403 is leap
    expect(toGregorian(1404, 1, 1)).toEqual({ gy: 2025, gm: 3, gd: 21 });
  });

  it("round-trips every day across several years without drift", () => {
    const start = Date.UTC(2020, 0, 1);
    const end = Date.UTC(2030, 0, 1);
    for (let t = start; t < end; t += 86_400_000) {
      const d = new Date(t);
      const { jy, jm, jd } = toJalali(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
      const back = toGregorian(jy, jm, jd);
      expect([back.gy, back.gm, back.gd]).toEqual([
        d.getUTCFullYear(),
        d.getUTCMonth() + 1,
        d.getUTCDate(),
      ]);
    }
  });

  it("knows leap years and month lengths", () => {
    expect(isLeapJalaliYear(1403)).toBe(true);
    expect(isLeapJalaliYear(1404)).toBe(false);
    expect(jalaliMonthLength(1403, 12)).toBe(30);
    expect(jalaliMonthLength(1404, 12)).toBe(29);
    expect(jalaliMonthLength(1404, 1)).toBe(31);
    expect(jalaliMonthLength(1404, 7)).toBe(30);
  });

  it("validates Jalali dates", () => {
    expect(isValidJalaliDate(1403, 12, 30)).toBe(true);
    expect(isValidJalaliDate(1404, 12, 30)).toBe(false);
    expect(isValidJalaliDate(1404, 13, 1)).toBe(false);
    expect(isValidJalaliDate(1404, 0, 1)).toBe(false);
  });

  it("formats ISO timestamps for display (Asia/Tehran)", () => {
    // 2024-03-19T22:00:00Z is already 1403/01/01 in Tehran (UTC+3:30)
    expect(formatJalali("2024-03-19T22:00:00Z")).toBe("1403/01/01");
    expect(formatJalali("2024-03-20T12:00:00Z", { withMonthName: true })).toBe(
      "1 فروردین 1403",
    );
  });

  it("parses Jalali back to ISO date string", () => {
    expect(jalaliToIsoDate(1403, 1, 1)).toBe("2024-03-20");
    expect(() => jalaliToIsoDate(1404, 12, 30)).toThrow();
  });
});
