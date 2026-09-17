import { describe, expect, it } from "vitest";
import {
  businessDateRange,
  businessDayHours,
  formatStartTime,
  isValidStartMinutes,
  parseStartTime,
  resolveLiveWindow,
  shiftIsoDate,
} from "./business-day";

describe("isValidStartMinutes", () => {
  it("accepts every whole minute inside a day", () => {
    expect(isValidStartMinutes(0)).toBe(true);
    expect(isValidStartMinutes(1080)).toBe(true);
    expect(isValidStartMinutes(1439)).toBe(true);
  });

  it("rejects a whole day, a negative offset and a fractional minute", () => {
    expect(isValidStartMinutes(1440)).toBe(false);
    expect(isValidStartMinutes(-1)).toBe(false);
    expect(isValidStartMinutes(90.5)).toBe(false);
  });

  it("rejects the shapes an untyped request body can arrive as", () => {
    expect(isValidStartMinutes("1080")).toBe(false);
    expect(isValidStartMinutes(null)).toBe(false);
    expect(isValidStartMinutes(undefined)).toBe(false);
    expect(isValidStartMinutes(Number.NaN)).toBe(false);
  });
});

describe("parseStartTime", () => {
  it("reads a 24-hour time as minutes after midnight", () => {
    expect(parseStartTime("18:00")).toBe(1080);
    expect(parseStartTime("06:30")).toBe(390);
    expect(parseStartTime("00:00")).toBe(0);
    expect(parseStartTime("23:59")).toBe(1439);
  });

  it("accepts a single-digit hour and surrounding whitespace", () => {
    expect(parseStartTime("6:00")).toBe(360);
    expect(parseStartTime("  18:00  ")).toBe(1080);
  });

  it("accepts Persian and Arabic-Indic digits, as a Persian-first form produces", () => {
    expect(parseStartTime("۱۸:۰۰")).toBe(1080);
    expect(parseStartTime("١٨:٣٠")).toBe(1110);
  });

  it("rejects rather than rounding an impossible or malformed time", () => {
    expect(parseStartTime("24:00")).toBeNull();
    expect(parseStartTime("18:60")).toBeNull();
    expect(parseStartTime("18")).toBeNull();
    expect(parseStartTime("18:0")).toBeNull();
    expect(parseStartTime("evening")).toBeNull();
    expect(parseStartTime("")).toBeNull();
  });

  it("accepts the HH:MM:SS an <input type=time> can submit", () => {
    // Firefox renders the seconds field once a control has seen a
    // seconds-bearing value, and some Android WebViews render it always; both
    // then submit "18:00:00", which the HH:MM-only rule rejected — a branch
    // got «ساعت شروع روز کاری معتبر نیست» for a time the browser's own widget
    // had produced.
    expect(parseStartTime("18:00:00")).toBe(1080);
    expect(parseStartTime("06:30:00")).toBe(390);
  });

  it("refuses a non-zero seconds part rather than truncating it", () => {
    // Whole minutes are the stored resolution, so 18:00:30 is a value this
    // cannot honour — and silently dropping the :30 would re-bucket the
    // branch's history against a time it did not choose.
    expect(parseStartTime("18:00:30")).toBeNull();
    expect(parseStartTime("18:00:60")).toBeNull();
  });
});

describe("formatStartTime", () => {
  it("round-trips with parseStartTime", () => {
    for (const minutes of [0, 390, 1080, 1110, 1439]) {
      expect(parseStartTime(formatStartTime(minutes))).toBe(minutes);
    }
  });

  it("zero-pads both halves so an <input type=time> accepts it", () => {
    expect(formatStartTime(0)).toBe("00:00");
    expect(formatStartTime(360)).toBe("06:00");
    expect(formatStartTime(1080)).toBe("18:00");
  });
});

describe("businessDayHours", () => {
  it("runs 00→23 when no business day is configured", () => {
    expect(businessDayHours(null)).toEqual(Array.from({ length: 24 }, (_, hour) => hour));
  });

  it("starts at the business day's own opening hour and wraps past midnight", () => {
    const hours = businessDayHours(1080);
    expect(hours[0]).toBe(18);
    expect(hours.slice(0, 8)).toEqual([18, 19, 20, 21, 22, 23, 0, 1]);
    expect(hours.at(-1)).toBe(17);
  });

  it("always covers each hour exactly once", () => {
    for (const start of [0, 390, 1080, 1439]) {
      expect(new Set(businessDayHours(start)).size).toBe(24);
    }
  });

  it("rotates by whole hours, since the buckets it labels are hours", () => {
    expect(businessDayHours(1110)).toEqual(businessDayHours(1080));
  });
});

describe("resolveLiveWindow", () => {
  // An 18:00→18:00 business day, and a cash-up at 03:00 inside it.
  const scheduledStart = "2026-08-16T14:30:00.000Z"; // 18:00 Tehran, 16 Aug
  const scheduledEnd = "2026-08-17T14:30:00.000Z"; // 18:00 Tehran, 17 Aug
  const threeAm = "2026-08-16T23:30:00.000Z"; // 03:00 Tehran, 17 Aug
  const tenPm = "2026-08-16T18:30:00.000Z"; // 22:00 Tehran, 16 Aug

  const base = {
    enabled: true,
    scheduledStart,
    scheduledEnd,
    lastClosedAt: null,
    lastShiftEndedAt: null,
    hasOpenShift: false,
  };

  it("starts at the scheduled start while the night is still running", () => {
    expect(resolveLiveWindow(base)).toEqual({
      windowStart: scheduledStart,
      closedBy: null,
      manuallyClosed: false,
    });
  });

  it("ends the night at the cash-up, so the board is zero for the rest of the day", () => {
    // The case that shipped wrong: at 11:00 the next morning the service is
    // long over, but on the clock alone the 18:00→18:00 day is still running.
    expect(
      resolveLiveWindow({ ...base, lastShiftEndedAt: threeAm, hasOpenShift: false }),
    ).toEqual({ windowStart: threeAm, closedBy: "shift", manuallyClosed: false });
  });

  it("treats a cash-up with someone still clocked in as a handover, not the end", () => {
    expect(
      resolveLiveWindow({ ...base, lastShiftEndedAt: tenPm, hasOpenShift: true }),
    ).toEqual({ windowStart: scheduledStart, closedBy: null, manuallyClosed: false });
  });

  it("still honours the manual close, for a branch whose staff never clock in", () => {
    expect(resolveLiveWindow({ ...base, lastClosedAt: threeAm })).toEqual({
      windowStart: threeAm,
      closedBy: "manual",
      manuallyClosed: true,
    });
  });

  it("takes the later of a cash-up and a manual close", () => {
    expect(
      resolveLiveWindow({ ...base, lastClosedAt: tenPm, lastShiftEndedAt: threeAm }),
    ).toEqual({ windowStart: threeAm, closedBy: "shift", manuallyClosed: false });

    expect(
      resolveLiveWindow({ ...base, lastClosedAt: threeAm, lastShiftEndedAt: tenPm }),
    ).toEqual({ windowStart: threeAm, closedBy: "manual", manuallyClosed: true });
  });

  it("expires both when the next business day starts on its own", () => {
    // Same closes, read during the *following* day: 18:00 has come round.
    expect(
      resolveLiveWindow({
        ...base,
        scheduledStart: scheduledEnd,
        scheduledEnd: "2026-08-18T14:30:00.000Z",
        lastClosedAt: threeAm,
        lastShiftEndedAt: threeAm,
      }),
    ).toEqual({ windowStart: scheduledEnd, closedBy: null, manuallyClosed: false });
  });

  it("ignores a cash-up from before the current day began", () => {
    expect(
      resolveLiveWindow({ ...base, lastShiftEndedAt: "2026-08-09T23:30:00.000Z" }),
    ).toEqual({ windowStart: scheduledStart, closedBy: null, manuallyClosed: false });
  });

  it("ignores all of it for a branch with no business day configured", () => {
    expect(
      resolveLiveWindow({
        ...base,
        enabled: false,
        lastClosedAt: threeAm,
        lastShiftEndedAt: threeAm,
      }),
    ).toEqual({ windowStart: scheduledStart, closedBy: null, manuallyClosed: false });
  });
});

describe("shiftIsoDate", () => {
  it("moves a business date by whole days", () => {
    expect(shiftIsoDate("2026-08-16", 1)).toBe("2026-08-17");
    expect(shiftIsoDate("2026-08-16", -1)).toBe("2026-08-15");
    expect(shiftIsoDate("2026-08-16", 0)).toBe("2026-08-16");
  });

  it("crosses month and year boundaries", () => {
    expect(shiftIsoDate("2026-08-31", 1)).toBe("2026-09-01");
    expect(shiftIsoDate("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftIsoDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftIsoDate("2024-03-01", -1)).toBe("2024-02-29");
  });

  it("returns a value it does not understand unchanged, rather than guessing", () => {
    expect(shiftIsoDate("", -1)).toBe("");
    expect(shiftIsoDate("2026-08", -1)).toBe("2026-08");
    expect(shiftIsoDate("not a date", -1)).toBe("not a date");
  });
});

describe("businessDateRange", () => {
  // The business day in progress at 01:00 of an 18:00→18:00 service: the
  // calendar says the 17th, the trading day is still the 16th.
  const today = "2026-08-16";

  it("asks for the business day in progress, not the calendar date", () => {
    expect(businessDateRange("current_day", today)).toEqual({
      dateFrom: "2026-08-16",
      dateTo: "2026-08-16",
    });
  });

  it("reads the previous business day as a single whole day", () => {
    expect(businessDateRange("previous_day", today)).toEqual({
      dateFrom: "2026-08-15",
      dateTo: "2026-08-15",
    });
  });

  it("counts the current business day inside the rolling windows", () => {
    expect(businessDateRange("last_7_days", today)).toEqual({
      dateFrom: "2026-08-10",
      dateTo: "2026-08-16",
    });
    expect(businessDateRange("last_30_days", today)).toEqual({
      dateFrom: "2026-07-18",
      dateTo: "2026-08-16",
    });
  });

  it("never produces a backwards range", () => {
    for (const preset of ["current_day", "previous_day", "last_7_days", "last_30_days"] as const) {
      const { dateFrom, dateTo } = businessDateRange(preset, today);
      expect(dateFrom <= dateTo).toBe(true);
    }
  });
});
