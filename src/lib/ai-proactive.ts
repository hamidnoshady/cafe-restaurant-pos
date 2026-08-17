/**
 * Phase 18b Wave 4 — pure scheduling and copy helpers for the proactive AI
 * jobs. Database access, tenancy and provider calls live in
 * ai-proactive-service.ts; keeping the clock and draft rules here makes the
 * safety-critical schedule deterministic and unit-testable.
 */

export const AI_PROACTIVE_TICK_INTERVAL_MS = 15 * 60 * 1000;
export const DEFAULT_PROACTIVE_TIMEZONE = "Asia/Tehran";
export const DEFAULT_PROACTIVE_HOUR = 8;
/** Saturday, using JavaScript's 0=Sunday weekday convention. */
export const DEFAULT_PROACTIVE_WEEKDAY = 6;

export type AiProactiveRunKind =
  | "daily_digest"
  | "weekly_digest"
  | "customer_debt_drafts"
  | "service_reminder_drafts";

export interface AiProactiveSettings {
  enabled: boolean;
  dailyDigestHour: number;
  weeklyDigestWeekday: number;
}

export const DEFAULT_AI_PROACTIVE_SETTINGS: AiProactiveSettings = {
  // Background turns consume a business's paid credits. Never opt a business
  // in silently; a manager explicitly enables this in the AI settings page.
  enabled: false,
  dailyDigestHour: DEFAULT_PROACTIVE_HOUR,
  weeklyDigestWeekday: DEFAULT_PROACTIVE_WEEKDAY,
};

export interface LocalBusinessClock {
  dateKey: string;
  hour: number;
  weekday: number;
}

function numericPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number {
  const value = parts.find((part) => part.type === type)?.value;
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`invalid local date part: ${type}`);
  return number;
}

/**
 * Resolves a stable local calendar key without depending on process timezone.
 * The returned weekday is calculated from the local Gregorian date, which is
 * also what the persisted period key represents.
 */
export function localBusinessClock(now: Date, timezone: string): LocalBusinessClock {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const year = numericPart(parts, "year");
  const month = numericPart(parts, "month");
  const day = numericPart(parts, "day");
  const hour = numericPart(parts, "hour");
  const dateKey = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  // Noon UTC preserves the weekday for the ISO date in every timezone.
  const weekday = new Date(`${dateKey}T12:00:00.000Z`).getUTCDay();
  return { dateKey, hour, weekday };
}

/** The idempotency key is per local business day, not server UTC day. */
export function proactivePeriodKey(kind: AiProactiveRunKind, clock: LocalBusinessClock): string {
  return kind === "weekly_digest" ? `${clock.dateKey}:weekly` : clock.dateKey;
}

/**
 * Daily operational digest and local-only debt drafts run once the business's
 * local morning begins. The weekly digest is an additional Saturday run.
 */
export function dueProactiveRuns(
  settings: AiProactiveSettings,
  clock: LocalBusinessClock,
): AiProactiveRunKind[] {
  if (!settings.enabled || clock.hour < settings.dailyDigestHour) return [];
  const runs: AiProactiveRunKind[] = ["daily_digest", "customer_debt_drafts", "service_reminder_drafts"];
  if (clock.weekday === settings.weeklyDigestWeekday) runs.push("weekly_digest");
  return runs;
}

/** Shift an ISO calendar date without relying on the runtime's local timezone. */
export function shiftIsoDate(dateKey: string, days: number): string {
  const atNoon = new Date(`${dateKey}T12:00:00.000Z`);
  atNoon.setUTCDate(atNoon.getUTCDate() + days);
  return atNoon.toISOString().slice(0, 10);
}

/**
 * Keep facts bounded before they are persisted or included in a provider
 * prompt. This avoids a long operational history quietly becoming a costly
 * background AI request while retaining enough rows for a useful digest.
 */
export function compactProactiveFacts(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 500);
  if (depth >= 4) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => compactProactiveFacts(item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 30)
        .map(([key, item]) => [key, compactProactiveFacts(item, depth + 1)]),
    );
  }
  return String(value).slice(0, 500);
}

/** A local-only, never-auto-sent reminder draft for a known customer debt. */
export function debtFollowUpDraft(customerName: string, balanceRial: number): string {
  const toman = Math.max(0, Math.trunc(balanceRial / 10)).toLocaleString("fa-IR");
  return [
    `سلام ${customerName} عزیز،`,
    `یادآوری دوستانه: ماندهٔ حساب شما نزد ما ${toman} تومان است.`,
    "لطفاً در فرصت مناسب وضعیت پرداخت را با ما هماهنگ کنید. سپاسگزاریم.",
  ].join("\n");
}

/**
 * A local-only, never-auto-sent shop-facing nudge that a sold watch is due
 * for service — the Wave 10 reminder that rides the existing job runner.
 */
export function serviceReminderDraft(itemName: string, serialNumber: string, dueDate: string): string {
  return [
    `یادآوری سرویس: «${itemName} — ${serialNumber}» موعد سرویس آن ${dueDate} است.`,
    "با مشتری تماس بگیرید و زمان سرویس را هماهنگ کنید. هیچ پیامی خودکار ارسال نشده است.",
  ].join("\n");
}
