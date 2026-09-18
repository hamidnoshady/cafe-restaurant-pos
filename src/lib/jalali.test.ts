import { afterEach, describe, expect, it } from "vitest";
import {
  formatJalali,
  formatShiftWindow,
  isLeapJalaliYear,
  isoDateToJalali,
  isValidIsoDate,
  isValidJalaliDate,
  jalaliMonthLength,
  jalaliToIsoDate,
  jalaliWeekdayColumn,
  postgresDateToIso,
  toGregorian,
  toJalali,
  isoDateInTimeZone,
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

  it("appends the Tehran wall-clock time when asked", () => {
    // 22:00Z + 3:30 = 01:30 local, on the next (Jalali) day.
    expect(formatJalali("2024-03-19T22:00:00Z", { withTime: true })).toBe("1403/01/01 01:30");
    expect(formatJalali("2024-03-20T12:00:00Z", { withMonthName: true, withTime: true })).toBe(
      "1 فروردین 1403، 15:30",
    );
    // Local midnight must read 00:00, not 24:00.
    expect(formatJalali("2024-03-19T20:30:00Z", { withTime: true })).toBe("1403/01/01 00:00");
    // Without the flag the output is unchanged — the option is additive.
    expect(formatJalali("2024-03-20T12:00:00Z")).toBe("1403/01/01");
  });

  it("parses Jalali back to ISO date string", () => {
    expect(jalaliToIsoDate(1403, 1, 1)).toBe("2024-03-20");
    expect(() => jalaliToIsoDate(1404, 12, 30)).toThrow();
  });

  it("parses only real ISO calendar dates to Jalali parts", () => {
    expect(isoDateToJalali("2024-03-20")).toEqual({ jy: 1403, jm: 1, jd: 1 });
    expect(isoDateToJalali("2026-07-22")).toEqual({ jy: 1405, jm: 4, jd: 31 });
    expect(isoDateToJalali("")).toBeNull();
    expect(isoDateToJalali("not-a-date")).toBeNull();
    expect(isoDateToJalali("2024-13-01")).toBeNull();
    expect(isoDateToJalali("2026-02-29")).toBeNull();
  });

  it("recognises a valid ISO date before it reaches a date column", () => {
    expect(isValidIsoDate("2024-02-29")).toBe(true);
    expect(isValidIsoDate("2026-02-29")).toBe(false);
    expect(isValidIsoDate("2026-04-31")).toBe(false);
    expect(isValidIsoDate("2026-4-01")).toBe(false);
    expect(isValidIsoDate("0000-01-01")).toBe(false);
    expect(isValidIsoDate(null)).toBe(false);
  });

  it("round-trips ISO ⇄ Jalali via the picker helpers", () => {
    const j = isoDateToJalali("2026-07-22")!;
    expect(jalaliToIsoDate(j.jy, j.jm, j.jd)).toBe("2026-07-22");
  });

  it("places Jalali dates in the right weekday column (0 = شنبه)", () => {
    // 1403/01/01 (Nowruz 1403) = 2024-03-20, a Wednesday → column 4.
    expect(jalaliWeekdayColumn(1403, 1, 1)).toBe(4);
    // 1404/01/01 = 2025-03-21, a Friday → column 6.
    expect(jalaliWeekdayColumn(1404, 1, 1)).toBe(6);
    // 2026-07-25 is a Saturday → column 0.
    const sat = isoDateToJalali("2026-07-25")!;
    expect(jalaliWeekdayColumn(sat.jy, sat.jm, sat.jd)).toBe(0);
  });
});

describe("formatShiftWindow", () => {
  it("renders a closed shift as both Jalali times, in Persian digits", () => {
    // 06:00Z + 3:30 = 09:30 Tehran, 12:30Z = 16:00 Tehran, both on 1405/05/20.
    expect(formatShiftWindow("2026-08-11T06:00:00Z~2026-08-11T12:30:00Z")).toBe(
      "۱۴۰۵/۰۵/۲۰ ۰۹:۳۰ تا ۱۴۰۵/۰۵/۲۰ ۱۶:۰۰",
    );
  });

  it("says the shift is still running when it has no end time", () => {
    expect(formatShiftWindow("2026-08-11T06:00:00Z~")).toBe("۱۴۰۵/۰۵/۲۰ ۰۹:۳۰ تا در حال انجام");
  });

  it("returns null for anything that isn't a shift window", () => {
    expect(formatShiftWindow("2026-08-11")).toBeNull();
    expect(formatShiftWindow("not-a-date")).toBeNull();
    expect(formatShiftWindow("2026-08-11T06:00:00Z")).toBeNull(); // no '~'
    expect(formatShiftWindow("")).toBeNull();
  });
});

describe("isoDateInTimeZone", () => {
  it("buckets an evening order on the local day, not the UTC one", () => {
    // 21:50Z is already 01:20 the next day in Tehran (+3:30) — the case that
    // made a date filter hide everything rung up after 20:30 local.
    expect(isoDateInTimeZone("2026-08-15T21:50:00Z")).toBe("2026-08-16");
    expect(new Date("2026-08-15T21:50:00Z").toISOString().slice(0, 10)).toBe("2026-08-15");
  });

  it("agrees with UTC in the middle of the day", () => {
    expect(isoDateInTimeZone("2026-08-15T09:00:00Z")).toBe("2026-08-15");
  });

  it("honours the time zone it is given", () => {
    expect(isoDateInTimeZone("2026-08-15T21:50:00Z", "UTC")).toBe("2026-08-15");
  });

  it("accepts a Date as readily as a string", () => {
    expect(isoDateInTimeZone(new Date("2026-03-20T20:30:00Z"))).toBe("2026-03-21");
  });

  it("returns null for something that isn't a date", () => {
    expect(isoDateInTimeZone("not-a-date")).toBeNull();
  });
});

describe("postgresDateToIso", () => {
  // node-postgres hands a Postgres `date` back as a JS Date at *local*
  // midnight, so the runner's own time zone decides what toISOString() says.
  // These tests pin TZ themselves rather than trusting the runner: CI runs in
  // UTC, where the bug is invisible, while the desktop app runs in Tehran,
  // where it silently shifts every business date back a day.
  const originalTz = process.env.TZ;
  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it("recovers the calendar date east of UTC, where toISOString is a day early", () => {
    process.env.TZ = "Asia/Tehran";
    const businessDate = new Date(2026, 7, 16); // what `date '2026-08-16'` becomes
    expect(postgresDateToIso(businessDate)).toBe("2026-08-16");
    // The bug this function exists to prevent — Tehran midnight is 20:30 the
    // previous day in UTC, so the old spelling reported the wrong day.
    expect(businessDate.toISOString().slice(0, 10)).toBe("2026-08-15");
  });

  it("agrees with toISOString on a UTC runner", () => {
    process.env.TZ = "UTC";
    const businessDate = new Date(2026, 7, 16);
    expect(postgresDateToIso(businessDate)).toBe("2026-08-16");
    expect(businessDate.toISOString().slice(0, 10)).toBe("2026-08-16");
  });

  it("recovers the calendar date west of UTC too", () => {
    process.env.TZ = "America/New_York";
    expect(postgresDateToIso(new Date(2026, 7, 16))).toBe("2026-08-16");
  });

  it("zero-pads single-digit months and days", () => {
    process.env.TZ = "Asia/Tehran";
    expect(postgresDateToIso(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("keeps the date across a Nowruz year boundary", () => {
    process.env.TZ = "Asia/Tehran";
    expect(postgresDateToIso(new Date(2026, 2, 21))).toBe("2026-03-21");
  });
});
