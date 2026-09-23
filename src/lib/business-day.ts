import { isoDateToJalali, jalaliToIsoDate } from "./jalali";

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
 *
 * A trailing `:SS` is accepted and ignored. `<input type="time">` is the only
 * thing that feeds this in practice, and a browser that decides to render the
 * seconds field (Firefox does once a control has ever seen a seconds-bearing
 * value, and some Android WebViews do unconditionally) submits "18:00:00" —
 * which the HH:MM-only regex rejected, so the branch got «ساعت شروع روز کاری
 * معتبر نیست» for a time it had picked out of the browser's own widget. Whole
 * minutes are still the stored resolution, so a non-zero seconds part is a
 * value this cannot honour and is refused rather than silently truncated.
 */
export function parseStartTime(text: string): number | null {
  const normalised = text
    .trim()
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(normalised);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] === undefined ? 0 : Number(match[3]);
  if (hour > 23 || minute > 59 || second !== 0) return null;
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
  /** False when the branch has no business day configured — closes are then ignored entirely. */
  enabled: boolean;
  /** When the business day now in progress began, as an ISO instant. */
  scheduledStart: string;
  /** When it ends on its own, as an ISO instant. */
  scheduledEnd: string;
  /** The branch's most recent manual «بستن روز کاری», if it has ever had one. */
  lastClosedAt: string | null;
  /** The branch's most recent shift cash-up (`employee_shifts.ended_at`). */
  lastShiftEndedAt: string | null;
  /** True while anyone is still clocked in at the branch — then a cash-up is a handover, not the end of the night. */
  hasOpenShift: boolean;
}

/** Why the live counters were reset before the business day's own end. */
export type LiveWindowCloseReason = "manual" | "shift";

export interface LiveWindow {
  /** Where the dashboard KPIs and the orders screen's closed list start counting from. */
  windowStart: string;
  /** How the day was ended early, or null while it is still running normally. */
  closedBy: LiveWindowCloseReason | null;
  /** True while a manual close is holding the live window past the scheduled start. */
  manuallyClosed: boolean;
}

/**
 * Where the *live* counters start: the scheduled start of the business day in
 * progress, unless the branch has already finished its night, in which case
 * the moment it finished.
 *
 * A business day that runs 18:00→18:00 is the right *reporting* bucket — one
 * service, one date, whatever the clock does at midnight — but it is the wrong
 * thing to put on a dashboard all day. A café whose service ends at 03:00 spent
 * the next fifteen hours looking at last night's takings, because on the clock
 * alone the day it belongs to was still running. Nothing about a start time can
 * tell you the night is over.
 *
 * The branch already says so, through a function that has existed since Phase
 * 20: the cashier closes their shift at the cash-up. So the night ends when the
 * till does — the branch's most recent `employee_shifts.ended_at`, and only
 * while *nobody* is still clocked in, because a cash-up with a colleague still
 * on the floor is a handover in the middle of the service rather than the end
 * of it. That guard is what keeps a shift change from blanking the board
 * mid-service.
 *
 * The manual «بستن روز کاری» stays as the override for a branch whose staff do
 * not clock in at all, and the later of the two wins. Both are bounded by the
 * business day they sit in, which is what makes them self-expiring: a cash-up
 * at 03:00 holds the window until 18:00 starts the next day on its own, and a
 * close from last week can never win.
 *
 * Reports are deliberately *not* derived from this — a sale rung after a close
 * still belongs to the business day it happened in (see migration 0076) — so
 * ending the night early can only ever reset what is on screen, never move
 * money between report rows.
 */
export function resolveLiveWindow(input: LiveWindowInput): LiveWindow {
  const { enabled, scheduledStart, scheduledEnd, lastClosedAt, lastShiftEndedAt, hasOpenShift } =
    input;
  if (!enabled) {
    return { windowStart: scheduledStart, closedBy: null, manuallyClosed: false };
  }

  const start = Date.parse(scheduledStart);
  const end = Date.parse(scheduledEnd);
  const withinCurrentDay = (iso: string | null): boolean => {
    if (!iso) return false;
    const at = Date.parse(iso);
    return at >= start && at < end;
  };

  const candidates: { at: string; reason: LiveWindowCloseReason }[] = [];
  if (withinCurrentDay(lastClosedAt)) {
    candidates.push({ at: lastClosedAt!, reason: "manual" });
  }
  // Only once the floor is empty: see the doc comment above on handovers.
  if (!hasOpenShift && withinCurrentDay(lastShiftEndedAt)) {
    candidates.push({ at: lastShiftEndedAt!, reason: "shift" });
  }
  if (candidates.length === 0) {
    return { windowStart: scheduledStart, closedBy: null, manuallyClosed: false };
  }

  const latest = candidates.reduce((a, b) => (Date.parse(b.at) > Date.parse(a.at) ? b : a));
  return {
    windowStart: latest.at,
    closedBy: latest.reason,
    manuallyClosed: latest.reason === "manual",
  };
}


/**
 * The branch's business date for an instant — the TypeScript twin of SQL's
 * `app_business_date(ts, tz, start_minutes)` (migration 0076), returning
 * `YYYY-MM-DD`.
 *
 * The database answers this for everything it buckets itself. This exists for
 * the one case that cannot ask it: a writer that must *supply* the trading day
 * a row belongs to — `journal_entries.entry_date` for a sale whose instant is
 * not `now()`, which is what the Holoo sales import writes — and so the rule
 * can be unit-tested against the same fixtures the SQL was written for.
 *
 * `startMinutes` NULL means the branch has no business day configured, which is
 * the calendar day in its own zone — exactly what the SQL function returns for
 * it.
 */
export function businessDateOf(instant: Date, timezone: string, startMinutes: number | null): string {
  const shifted = new Date(instant.getTime() - (startMinutes ?? 0) * 60_000);
  // `en-CA` renders as YYYY-MM-DD, and the timeZone option does the
  // `AT TIME ZONE` half. Intl is the only zone database in the runtime, so
  // this is also the only way to agree with Postgres without asking it.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(shifted);
}

/**
 * Plain calendar arithmetic on a `YYYY-MM-DD` business date — no timezone
 * involved, because a business date is already the answer to "which day", not
 * an instant. Returns the input unchanged if it is not a date this understands,
 * so a caller can never turn a bad value into a confidently wrong range.
 */
export function shiftIsoDate(iso: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const shifted = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days),
  );
  return shifted.toISOString().slice(0, 10);
}

/**
 * The quick ranges the reports screen offers, expressed in *business* dates.
 *
 * This is the half of the feature reports were missing. Every report buckets on
 * `app_business_date` now, but the date pickers above them are a calendar: at
 * 01:00 during an 18:00→18:00 service, picking "today" off that calendar asks
 * for tomorrow's business day and returns an empty report, while the service
 * the user is standing in is filed under yesterday's date. Anchoring the
 * presets on the branch's current business date — which the server reports —
 * removes the need for anyone to work that out.
 */
export type BusinessDateRangePreset =
  | "current_day"
  | "previous_day"
  | "current_week"
  | "current_month"
  | "last_7_days"
  | "last_30_days";

export interface BusinessDateRange {
  dateFrom: string;
  dateTo: string;
}

export function businessDateRange(
  preset: BusinessDateRangePreset,
  currentBusinessDate: string,
): BusinessDateRange {
  const today = currentBusinessDate;
  switch (preset) {
    case "current_day":
      return { dateFrom: today, dateTo: today };
    case "previous_day": {
      const yesterday = shiftIsoDate(today, -1);
      return { dateFrom: yesterday, dateTo: yesterday };
    }
    case "current_week": {
      // Iranian weeks start on Saturday. getUTCDay(): Saturday=6, Sunday=0.
      const day = new Date(`${today}T00:00:00Z`).getUTCDay();
      return { dateFrom: shiftIsoDate(today, -((day + 1) % 7)), dateTo: today };
    }
    case "current_month": {
      // Reports are Persian-first: «این ماه» means the current Jalali month,
      // while the wire remains an ISO/Gregorian date.
      const jalali = isoDateToJalali(today);
      return { dateFrom: jalali ? jalaliToIsoDate(jalali.jy, jalali.jm, 1) : today, dateTo: today };
    }
    // Inclusive of the current business day, so "۷ روز اخیر" is seven days of
    // trading and not six plus a partial one.
    case "last_7_days":
      return { dateFrom: shiftIsoDate(today, -6), dateTo: today };
    case "last_30_days":
      return { dateFrom: shiftIsoDate(today, -29), dateTo: today };
  }
}
