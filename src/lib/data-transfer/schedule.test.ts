/**
 * `nextRunAt` — when a scheduled export is next due.
 *
 * Pure and therefore tested directly, because the alternative is discovering
 * the rule is wrong when a business's «فروش روزانه» arrives at four in the
 * afternoon, or twice, or not at all on the 31st.
 *
 * Every expectation below is stated in the *business's* wall clock, which is
 * the whole point: "every morning at seven" is a claim about the shop's
 * morning, not about UTC.
 */
import { describe, expect, it } from "vitest";
import { nextRunAt } from "./schedule-service";

const TEHRAN = "Asia/Tehran";

/** The wall-clock reading of an instant in a zone, for readable assertions. */
function wallClock(at: Date, timeZone = TEHRAN): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(at)
    .replace(",", "");
}

/** 0 = شنبه … 6 = جمعه, read in the target zone. */
function persianWeekday(at: Date, timeZone = TEHRAN): number {
  const day = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(at);
  return (["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(day) + 1) % 7;
}

describe("daily", () => {
  it("is later the same day when the hour has not passed", () => {
    const after = new Date("2026-03-10T00:00:00Z"); // 03:30 Tehran
    const next = nextRunAt({ frequency: "daily", hourLocal: 7 }, after, TEHRAN);
    expect(wallClock(next)).toBe("2026-03-10 07:00");
  });

  it("rolls to tomorrow once the hour has passed", () => {
    const after = new Date("2026-03-10T06:00:00Z"); // 09:30 Tehran
    const next = nextRunAt({ frequency: "daily", hourLocal: 7 }, after, TEHRAN);
    expect(wallClock(next)).toBe("2026-03-11 07:00");
  });

  it("never answers a moment in the past", () => {
    const after = new Date("2026-03-10T03:30:00Z");
    for (let hour = 0; hour < 24; hour += 1) {
      const next = nextRunAt({ frequency: "daily", hourLocal: hour }, after, TEHRAN);
      expect(next.getTime(), `hour ${hour}`).toBeGreaterThan(after.getTime());
    }
  });

  it("means the same wall-clock hour in a different zone", () => {
    // The zone is the business's, so "07:00" is 07:00 wherever the server is.
    const after = new Date("2026-03-10T00:00:00Z");
    const next = nextRunAt({ frequency: "daily", hourLocal: 7 }, after, "Europe/London");
    expect(wallClock(next, "Europe/London")).toBe("2026-03-10 07:00");
  });
});

describe("weekly", () => {
  it("lands on the requested day of the Persian week", () => {
    const after = new Date("2026-03-10T00:00:00Z");
    for (let weekday = 0; weekday <= 6; weekday += 1) {
      const next = nextRunAt({ frequency: "weekly", hourLocal: 7, weekday }, after, TEHRAN);
      expect(persianWeekday(next), `weekday ${weekday}`).toBe(weekday);
      expect(wallClock(next).endsWith("07:00")).toBe(true);
      expect(next.getTime()).toBeGreaterThan(after.getTime());
      // Always within the coming week.
      expect(next.getTime() - after.getTime()).toBeLessThan(8 * 24 * 3600_000);
    }
  });

  it("skips to next week when today is the day but the hour has passed", () => {
    const after = new Date("2026-03-14T06:00:00Z"); // Saturday 09:30 Tehran
    expect(persianWeekday(after)).toBe(0);
    const next = nextRunAt({ frequency: "weekly", hourLocal: 7, weekday: 0 }, after, TEHRAN);
    expect(persianWeekday(next)).toBe(0);
    expect(next.getTime() - after.getTime()).toBeGreaterThan(6 * 24 * 3600_000);
  });

  it("treats a missing weekday as شنبه rather than throwing", () => {
    const next = nextRunAt(
      { frequency: "weekly", hourLocal: 7, weekday: null },
      new Date("2026-03-10T00:00:00Z"),
      TEHRAN,
    );
    expect(persianWeekday(next)).toBe(0);
  });
});

describe("monthly", () => {
  it("lands on the requested day of the month", () => {
    const after = new Date("2026-03-10T00:00:00Z");
    const next = nextRunAt(
      { frequency: "monthly", hourLocal: 7, dayOfMonth: 15 },
      after,
      TEHRAN,
    );
    expect(wallClock(next)).toBe("2026-03-15 07:00");
  });

  it("rolls to next month once the day has passed", () => {
    const after = new Date("2026-03-20T00:00:00Z");
    const next = nextRunAt(
      { frequency: "monthly", hourLocal: 7, dayOfMonth: 15 },
      after,
      TEHRAN,
    );
    expect(wallClock(next)).toBe("2026-04-15 07:00");
  });

  it("clamps the 31st to the last day of a short month", () => {
    // The bug this prevents: an accounting export set for "the 31st" silently
    // skipping every 30-day month, or landing on the 1st of the next one and
    // being filed against the wrong period.
    const after = new Date("2026-04-05T00:00:00Z");
    const next = nextRunAt(
      { frequency: "monthly", hourLocal: 7, dayOfMonth: 31 },
      after,
      TEHRAN,
    );
    expect(wallClock(next)).toBe("2026-04-30 07:00");
  });

  it("clamps to the 28th in a non-leap February", () => {
    const after = new Date("2026-02-05T00:00:00Z");
    const next = nextRunAt(
      { frequency: "monthly", hourLocal: 7, dayOfMonth: 31 },
      after,
      TEHRAN,
    );
    expect(wallClock(next)).toBe("2026-02-28 07:00");
  });

  it("never answers a moment in the past, on any day of any month", () => {
    for (const iso of [
      "2026-01-01T00:00:00Z",
      "2026-02-27T23:00:00Z",
      "2026-04-30T12:00:00Z",
      "2026-12-31T20:30:00Z",
    ]) {
      const after = new Date(iso);
      for (const dayOfMonth of [1, 15, 28, 31]) {
        const next = nextRunAt({ frequency: "monthly", hourLocal: 7, dayOfMonth }, after, TEHRAN);
        expect(next.getTime(), `${iso} / ${dayOfMonth}`).toBeGreaterThan(after.getTime());
      }
    }
  });
});
