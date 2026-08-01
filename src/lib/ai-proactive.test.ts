import { describe, expect, it } from "vitest";
import {
  DEFAULT_AI_PROACTIVE_SETTINGS,
  compactProactiveFacts,
  debtFollowUpDraft,
  dueProactiveRuns,
  localBusinessClock,
  proactivePeriodKey,
  shiftIsoDate,
} from "./ai-proactive";

describe("proactive AI scheduling", () => {
  it("keeps background AI opt-in by default", () => {
    expect(dueProactiveRuns(DEFAULT_AI_PROACTIVE_SETTINGS, { dateKey: "2026-08-01", hour: 12, weekday: 6 })).toEqual([]);
  });

  it("schedules one daily digest, debt drafts and the weekly digest in local time", () => {
    const settings = { ...DEFAULT_AI_PROACTIVE_SETTINGS, enabled: true };
    expect(dueProactiveRuns(settings, { dateKey: "2026-08-01", hour: 7, weekday: 6 })).toEqual([]);
    expect(dueProactiveRuns(settings, { dateKey: "2026-08-01", hour: 8, weekday: 6 })).toEqual([
      "daily_digest",
      "customer_debt_drafts",
      "weekly_digest",
    ]);
    expect(proactivePeriodKey("weekly_digest", { dateKey: "2026-08-01", hour: 8, weekday: 6 })).toBe("2026-08-01:weekly");
  });

  it("uses the business timezone instead of the server timezone", () => {
    const clock = localBusinessClock(new Date("2026-07-31T21:30:00.000Z"), "Asia/Tehran");
    expect(clock).toMatchObject({ dateKey: "2026-08-01", hour: 1, weekday: 6 });
    expect(shiftIsoDate("2026-08-01", -7)).toBe("2026-07-25");
  });

  it("bounds nested facts before a scheduled provider request", () => {
    const result = compactProactiveFacts({ rows: Array.from({ length: 24 }, (_, index) => ({ index, value: "x".repeat(700) })) }) as {
      rows: { index: number; value: string }[];
    };
    expect(result.rows).toHaveLength(20);
    expect(result.rows[0].value).toHaveLength(500);
  });

  it("builds a polite draft that never claims to have sent anything", () => {
    const draft = debtFollowUpDraft("مریم", 125_000);
    expect(draft).toContain("مریم");
    expect(draft).toContain("۱۲٬۵۰۰ تومان");
    expect(draft).not.toContain("ارسال شد");
  });
});
