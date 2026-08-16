import { describe, expect, it } from "vitest";
import {
  businessDayHours,
  formatStartTime,
  isValidStartMinutes,
  parseStartTime,
  resolveLiveWindow,
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
  const closedAtThreeAm = "2026-08-16T23:30:00.000Z"; // 03:00 Tehran, 17 Aug

  it("starts at the scheduled start when the day has not been closed by hand", () => {
    expect(
      resolveLiveWindow({ enabled: true, scheduledStart, scheduledEnd, lastClosedAt: null }),
    ).toEqual({ windowStart: scheduledStart, manuallyClosed: false });
  });

  it("moves to the close, so the screens go to zero the moment the day is cashed up", () => {
    expect(
      resolveLiveWindow({
        enabled: true,
        scheduledStart,
        scheduledEnd,
        lastClosedAt: closedAtThreeAm,
      }),
    ).toEqual({ windowStart: closedAtThreeAm, manuallyClosed: true });
  });

  it("expires the close when the next business day starts on its own", () => {
    // Same closure, now read during the *following* day: 18:00 has come round.
    expect(
      resolveLiveWindow({
        enabled: true,
        scheduledStart: scheduledEnd,
        scheduledEnd: "2026-08-18T14:30:00.000Z",
        lastClosedAt: closedAtThreeAm,
      }),
    ).toEqual({ windowStart: scheduledEnd, manuallyClosed: false });
  });

  it("ignores a closure recorded before the current day began", () => {
    expect(
      resolveLiveWindow({
        enabled: true,
        scheduledStart,
        scheduledEnd,
        lastClosedAt: "2026-08-09T23:30:00.000Z",
      }),
    ).toEqual({ windowStart: scheduledStart, manuallyClosed: false });
  });

  it("ignores closures entirely for a branch with no business day configured", () => {
    expect(
      resolveLiveWindow({
        enabled: false,
        scheduledStart,
        scheduledEnd,
        lastClosedAt: closedAtThreeAm,
      }),
    ).toEqual({ windowStart: scheduledStart, manuallyClosed: false });
  });
});
