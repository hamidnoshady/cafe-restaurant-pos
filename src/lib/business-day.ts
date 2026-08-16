/**
 * The business day (روز کاری) — the framework-free half.
 *
 * A branch's trading day does not have to start at local midnight. A café
 * working 18:00→03:00 trades one service, and bucketing it on the calendar
 * date splits that service in two: the dashboard zeroes at 00:00 while the
 * till is still open, and the evening lands on two report rows. Setting the
 * branch's business day to start at 18:00 makes its days run 18:00 → 18:00, so
 * the whole service is one day with one date, and the counters only go back to
 * zero when the *next* business day starts.
 *
 * `startMinutes` is minutes after local midnight, or null for "not configured"
 * — the default, and the setting every existing branch keeps. Null behaves
 * exactly like 0 arithmetically (the calendar day, unchanged), so nothing
 * moves for a business that does not turn this on; the two are kept distinct
 * only so "management chose midnight" and "management never chose" stay
 * distinguishable in the settings UI.
 *
 * The date arithmetic itself lives in SQL (`app_business_date`, migration
 * 0076) because that is where the branch's own timezone is known and where the
 * reporting views need it. What is here is what the app layer decides on top:
 * parsing and formatting the setting, the order the dashboard's hourly axis
 * runs in once a day no longer starts at 00:00, and how a manual "close the
 * day now" interacts with the scheduled window.
 */

export const MINUTES_PER_DAY = 1440;
export const MINUTES_PER_HOUR = 60;

/** Minutes after local midnight, whole and inside one day — what the column stores. */
export function isValidStartMinutes(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < MINUTES_PER_DAY
  );
}

/**
 * "18:00" → 1080. Returns null for anything that is not a 24-hour HH:MM — the
 * settings form and the API both treat that as "reject", never as "midnight",
 * so a typo can't silently re-bucket a branch's whole history.
 *
 * Persian digits are accepted because the form is Persian-first and a numeric
 * keypad on a Persian device produces them; they are display-only everywhere
 * else in the app (see digits.ts) and normalised away here.
 */
export function parseStartTime(text: string): number | null {
  const normalised = text
    .trim()
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
  const match = /^(\d{1,2}):(\d{2})$/.exec(normalised);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * MINUTES_PER_HOUR + minute;
}

/** 1080 → "18:00". Latin digits: this is the value an `<input type="time">` round-trips. */
export function formatStartTime(minutes: number): string {
  const hour = Math.floor(minutes / MINUTES_PER_HOUR);
  const minute = minutes % MINUTES_PER_HOUR;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * The 24 hours of a business day, in the order they are actually worked.
 *
 * The dashboard's sales-trend chart has always drawn a fixed 00→23 axis, which
 * for an 18:00 business day would put the small hours of the *end* of the
 * service on the far left and the opening hour two thirds of the way along.
 * Rotating the axis to begin at the business day's start hour makes the chart
 * read left-to-right in trading order again.
 *
 * Rotation is by whole hours: a business day starting at 18:30 still draws an
 * axis of hour buckets beginning at 18, because the buckets are hours — the
 * half hour before 18:30 belongs to the previous business day and simply has
 * no orders in this window to plot.
 */
export function businessDayHours(startMinutes: number | null): number[] {
  const startHour = Math.floor((startMinutes ?? 0) / MINUTES_PER_HOUR);
  return Array.from({ length: 24 }, (_, index) => (startHour + index) % 24);
}

export interface LiveWindowInput {
  /** False when the branch has no business day configured — closures are then ignored entirely. */
  enabled: boolean;
  /** When the business day now in progress began, as an ISO instant. */
  scheduledStart: string;
  /** When it ends on its own, as an ISO instant. */
  scheduledEnd: string;
  /** The branch's most recent manual close, if it has ever had one. */
  lastClosedAt: string | null;
}

export interface LiveWindow {
  /** Where the dashboard KPIs and the orders screen's closed list start counting from. */
  windowStart: string;
  /** True while a manual close is holding the live window open past the scheduled start. */
  manuallyClosed: boolean;
}

/**
 * Where the *live* counters start: normally the scheduled start of the
 * business day in progress, but a later manual close wins until the next
 * business day begins on its own.
 *
 * That "until the next one begins" is what makes closures self-expiring: a
 * close recorded at 03:00 sits inside the 18:00→18:00 day it ended, so it
 * holds the window; once 18:00 comes round the scheduled start is later than
 * it and the branch starts the new day at zero with nothing to clean up. A
 * closure from last week can never win.
 *
 * Reports are deliberately *not* derived from this — a sale rung after a close
 * still belongs to the business day it happened in (see migration 0076) — so
 * closing the day early can only ever reset what is on screen, never move
 * money between report rows.
 */
export function resolveLiveWindow(input: LiveWindowInput): LiveWindow {
  const { enabled, scheduledStart, scheduledEnd, lastClosedAt } = input;
  if (!enabled || !lastClosedAt) {
    return { windowStart: scheduledStart, manuallyClosed: false };
  }
  const closed = Date.parse(lastClosedAt);
  const start = Date.parse(scheduledStart);
  const end = Date.parse(scheduledEnd);
  const withinCurrentDay = closed >= start && closed < end;
  return withinCurrentDay
    ? { windowStart: lastClosedAt, manuallyClosed: true }
    : { windowStart: scheduledStart, manuallyClosed: false };
}
