import { describe, expect, it } from "vitest";
import { gregorianMonthLength, isGregorianLeapYear, isValidIsoDate, normalizeOptionalIsoDate } from "./iso-date";

describe("isGregorianLeapYear", () => {
  it("accepts a year divisible by 4", () => {
    expect(isGregorianLeapYear(2024)).toBe(true);
  });

  it("rejects a century that is not divisible by 400", () => {
    expect(isGregorianLeapYear(1900)).toBe(false);
  });

  it("accepts a century divisible by 400", () => {
    expect(isGregorianLeapYear(2000)).toBe(true);
  });
});

describe("gregorianMonthLength", () => {
  it("knows February in a leap year and a common year", () => {
    expect(gregorianMonthLength(2024, 2)).toBe(29);
    expect(gregorianMonthLength(2025, 2)).toBe(28);
  });

  it("returns 0 for a month outside 1..12", () => {
    expect(gregorianMonthLength(2025, 0)).toBe(0);
    expect(gregorianMonthLength(2025, 13)).toBe(0);
  });
});

describe("isValidIsoDate", () => {
  it("accepts a real date", () => {
    expect(isValidIsoDate("2026-09-17")).toBe(true);
  });

  it("rejects a non-string", () => {
    expect(isValidIsoDate(20260917)).toBe(false);
    expect(isValidIsoDate(null)).toBe(false);
    expect(isValidIsoDate(undefined)).toBe(false);
  });

  it("rejects free text", () => {
    expect(isValidIsoDate("banana")).toBe(false);
    expect(isValidIsoDate("")).toBe(false);
  });

  it("rejects another shape", () => {
    expect(isValidIsoDate("2026/09/17")).toBe(false);
    expect(isValidIsoDate("26-09-17")).toBe(false);
    // A timestamp is not a date: the column is `date`, and the extra text is a cast error.
    expect(isValidIsoDate("2026-09-17T10:00:00Z")).toBe(false);
  });

  it("rejects a well-shaped date that does not exist", () => {
    // The bug a shape-only regex misses — Postgres raises 22008 on these.
    expect(isValidIsoDate("2026-02-31")).toBe(false);
    expect(isValidIsoDate("2026-13-01")).toBe(false);
    expect(isValidIsoDate("2026-00-10")).toBe(false);
    expect(isValidIsoDate("2026-09-00")).toBe(false);
    expect(isValidIsoDate("2026-04-31")).toBe(false);
  });

  it("accepts 29 February only in a leap year", () => {
    expect(isValidIsoDate("2024-02-29")).toBe(true);
    expect(isValidIsoDate("2025-02-29")).toBe(false);
  });
});

describe("normalizeOptionalIsoDate", () => {
  it("treats absent, null and blank as «no date given»", () => {
    expect(normalizeOptionalIsoDate(undefined)).toEqual({ ok: true, value: null });
    expect(normalizeOptionalIsoDate(null)).toEqual({ ok: true, value: null });
    expect(normalizeOptionalIsoDate("")).toEqual({ ok: true, value: null });
    // Whitespace must never be forwarded: `''::date` is itself a cast error.
    expect(normalizeOptionalIsoDate("   ")).toEqual({ ok: true, value: null });
  });

  it("trims and returns a valid date", () => {
    expect(normalizeOptionalIsoDate(" 2026-09-17 ")).toEqual({ ok: true, value: "2026-09-17" });
  });

  it("refuses an invalid date rather than passing it to Postgres", () => {
    expect(normalizeOptionalIsoDate("banana")).toEqual({ ok: false });
    expect(normalizeOptionalIsoDate("2026-02-31")).toEqual({ ok: false });
    expect(normalizeOptionalIsoDate(42)).toEqual({ ok: false });
    expect(normalizeOptionalIsoDate({})).toEqual({ ok: false });
  });
});
