/**
 * Jalali (Shamsi) ⇄ Gregorian conversion — display layer only.
 * Dates are always STORED as ISO/Gregorian; convert at the edge.
 *
 * Port of the well-established jalaali-js algorithm (MIT), which follows the
 * astronomical 33-year cycle used by the official Iranian calendar.
 */
import { toPersianDigits } from "./digits";

export interface JalaliDate {
  jy: number;
  jm: number; // 1..12
  jd: number; // 1..31
}

const BREAKS = [
  -61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097,
  2192, 2262, 2324, 2394, 2456, 3178,
];

function div(a: number, b: number): number {
  return Math.trunc(a / b);
}

function mod(a: number, b: number): number {
  return a - Math.trunc(a / b) * b;
}

function jalCal(jy: number): { leap: number; gy: number; march: number } {
  const bl = BREAKS.length;
  const gy = jy + 621;
  let leapJ = -14;
  let jp = BREAKS[0];

  if (jy < jp || jy >= BREAKS[bl - 1]) {
    throw new Error(`Invalid Jalali year ${jy}`);
  }

  let jump = 0;
  for (let i = 1; i < bl; i += 1) {
    const jm = BREAKS[i];
    jump = jm - jp;
    if (jy < jm) break;
    leapJ = leapJ + div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  let n = jy - jp;

  leapJ = leapJ + div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;

  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;

  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;

  return { leap, gy, march };
}

function g2d(gy: number, gm: number, gd: number): number {
  let d =
    div((gy + div(gm - 8, 6) + 100100) * 1461, 4) +
    div(153 * mod(gm + 9, 12) + 2, 5) +
    gd -
    34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}

function d2g(jdn: number): { gy: number; gm: number; gd: number } {
  let j = 4 * jdn + 139361631;
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gd = div(mod(i, 153), 5) + 1;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return { gy, gm, gd };
}

function j2d(jy: number, jm: number, jd: number): number {
  const r = jalCal(jy);
  return g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1;
}

function d2j(jdn: number): JalaliDate {
  const gy = d2g(jdn).gy;
  let jy = gy - 621;
  const r = jalCal(jy);
  const jdn1f = g2d(gy, 3, r.march);
  let jd: number;
  let jm: number;
  let k = jdn - jdn1f;
  if (k >= 0) {
    if (k <= 185) {
      jm = 1 + div(k, 31);
      jd = mod(k, 31) + 1;
      return { jy, jm, jd };
    }
    k -= 186;
  } else {
    jy -= 1;
    k += 179;
    if (r.leap === 1) k += 1;
  }
  jm = 7 + div(k, 30);
  jd = mod(k, 30) + 1;
  return { jy, jm, jd };
}

/** Gregorian → Jalali. Months are 1-based. */
export function toJalali(gy: number, gm: number, gd: number): JalaliDate {
  return d2j(g2d(gy, gm, gd));
}

/** Jalali → Gregorian. Months are 1-based. */
export function toGregorian(jy: number, jm: number, jd: number): { gy: number; gm: number; gd: number } {
  return d2g(j2d(jy, jm, jd));
}

export function isLeapJalaliYear(jy: number): boolean {
  return jalCal(jy).leap === 0;
}

export function jalaliMonthLength(jy: number, jm: number): number {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  return isLeapJalaliYear(jy) ? 30 : 29;
}

export function isValidJalaliDate(jy: number, jm: number, jd: number): boolean {
  return (
    jy > BREAKS[0] &&
    jy < BREAKS[BREAKS.length - 1] &&
    jm >= 1 &&
    jm <= 12 &&
    jd >= 1 &&
    jd <= jalaliMonthLength(jy, jm)
  );
}

export const JALALI_MONTHS = [
  "فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور",
  "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند",
] as const;

export const JALALI_WEEKDAYS = [
  "یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه", "شنبه",
] as const;

/**
 * Format a Date (or ISO string) as a Jalali date string, **in Persian digits**.
 * Uses the date's value in the given IANA time zone (default Asia/Tehran) —
 * storage stays ISO/UTC, only display shifts.
 *
 * `withTime` appends the wall-clock time in that same zone (24-hour, zero
 * padded) — needed wherever an exact moment matters rather than just the day
 * (shift start/end, audit events).
 *
 * The digits are Persian because this function's output is, without exception,
 * user-facing text. It used to return ASCII digits, which made every caller
 * responsible for remembering `toPersianDigits(...)` — and 42 of 193 call sites
 * did not, so the same table could show «۱۴۰۴/۱۲/۲۴» in one column and
 * "1404/12/24" in the next. Converting here makes the correct thing the
 * default; `toPersianDigits` only rewrites `[0-9]`, so the ~100 callers that
 * already wrap this call are unaffected (it is idempotent).
 *
 * If you need ASCII — a filename, a sort key, an API payload — do not use this
 * function. It is a display formatter. Use the ISO value you already have, or
 * `toLatinDigits()` on the result if you truly need the Jalali calendar in
 * machine form.
 */
export function formatJalali(
  date: Date | string,
  opts: { withMonthName?: boolean; timeZone?: string; withTime?: boolean } = {},
): string {
  const { withMonthName = false, timeZone = "Asia/Tehran", withTime = false } = opts;
  const d = typeof date === "string" ? new Date(date) : date;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    ...(withTime ? { hour: "2-digit" as const, minute: "2-digit" as const, hour12: false } : {}),
  }).formatToParts(d);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const { jy, jm, jd } = toJalali(get("year"), get("month"), get("day"));

  const pad = (n: number) => String(n).padStart(2, "0");
  // Intl renders midnight as hour "24" under hour12:false in some runtimes.
  const time = withTime ? `${pad(get("hour") % 24)}:${pad(get("minute"))}` : "";

  if (withMonthName) {
    const day = `${toPersianDigits(jd)} ${JALALI_MONTHS[jm - 1]} ${toPersianDigits(jy)}`;
    return withTime ? `${day}، ${toPersianDigits(time)}` : day;
  }
  const day = `${toPersianDigits(jy)}/${toPersianDigits(pad(jm))}/${toPersianDigits(pad(jd))}`;
  return withTime ? `${day} ${toPersianDigits(time)}` : day;
}

/**
 * "<startISO>~<endISO>" — a shift's exact window, emitted by
 * v_employee_shift_reconciliation's `shift_window` column (migration 0061) as
 * machine-readable UTC ISO-8601 (Jalali conversion is display-layer only).
 * The end half is empty while the shift is still open.
 */
const SHIFT_WINDOW_RE = /^(\d{4}-\d{2}-\d{2}T[\d:]+Z)~(\d{4}-\d{2}-\d{2}T[\d:]+Z)?$/;

/**
 * Render a shift_window value as "<start> تا <end>" in Jalali + Tehran time,
 * or null if the value isn't a shift window. Lives here rather than in
 * reports.ts so the report table, CSV/Excel export and PDF template share one
 * implementation — reports.ts pulls in node:crypto and can't be imported by a
 * client component.
 */
export function formatShiftWindow(value: string): string | null {
  const m = SHIFT_WINDOW_RE.exec(value);
  if (!m) return null;
  const start = toPersianDigits(formatJalali(m[1], { withTime: true }));
  const end = m[2] ? toPersianDigits(formatJalali(m[2], { withTime: true })) : "در حال انجام";
  return `${start} تا ${end}`;
}

/** Parse a Jalali date (y/m/d) into an ISO calendar date string (YYYY-MM-DD). */export function jalaliToIsoDate(jy: number, jm: number, jd: number): string {
  if (!isValidJalaliDate(jy, jm, jd)) {
    throw new Error(`Invalid Jalali date ${jy}/${jm}/${jd}`);
  }
  const { gy, gm, gd } = toGregorian(jy, jm, jd);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${gy}-${pad(gm)}-${pad(gd)}`;
}

/**
 * Whether a value is a real ISO calendar date (YYYY-MM-DD), not merely a
 * string that resembles one. A date column accepts calendar days, so
 * `2026-02-31` must not silently roll into March in the client or turn into a
 * low-level Postgres cast error at the API boundary.
 */
export function isValidIsoDate(iso: unknown): iso is string {
  if (typeof iso !== "string") return false;
  const trimmed = iso.trim();
  // PostgreSQL's date type starts at 0001 AD. Year zero is accepted by
  // JavaScript's proleptic ISO parser but would fail at the database boundary.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed) || trimmed.startsWith("0000-")) return false;
  const parsed = new Date(`${trimmed}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === trimmed;
}

/**
 * Parse an ISO calendar date string (YYYY-MM-DD) into its Jalali parts, or
 * null if the input isn't a well-formed ISO date. The mirror of
 * jalaliToIsoDate — used by date-picker UIs that store ISO but display Jalali.
 */
export function isoDateToJalali(iso: string): JalaliDate | null {
  const trimmed = iso.trim();
  if (!isValidIsoDate(trimmed)) return null;
  const [gy, gm, gd] = trimmed.split("-").map(Number);
  return toJalali(gy, gm, gd);
}

/**
 * The calendar date (YYYY-MM-DD, Gregorian) an instant falls on in a time zone
 * — the same "which day was this?" question `todayJalali` answers for now.
 *
 * `new Date(iso).toISOString().slice(0, 10)` looks like this but is the date in
 * *UTC*, which is a different day for a third of every Tehran evening: an order
 * rung up at 01:20 local is 21:50 the previous day in UTC. Anything comparing a
 * timestamp against a date the user picked on a calendar has to bucket it the
 * way that calendar does, or the last hours of each day go missing.
 */
export function isoDateInTimeZone(
  value: Date | string,
  timeZone = "Asia/Tehran",
): string | null {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  const [year, month, day] = [get("year"), get("month"), get("day")];
  return year && month && day ? `${year}-${month}-${day}` : null;
}

/**
 * The calendar date (YYYY-MM-DD) a node-postgres `date` value names.
 *
 * node-postgres returns a Postgres `date` (no time) as a JS Date at *local*
 * midnight, so `value.toISOString().slice(0, 10)` is wrong for any runner
 * east of UTC — Tehran midnight is 20:30 the previous day in UTC, and the
 * date silently shifts back one day (the desktop app runs on exactly such a
 * machine). Reading the Date's local components recovers the calendar date
 * the database returned, on every runner timezone, UTC included.
 */
export function postgresDateToIso(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Today's date as Jalali parts, in the given IANA time zone (default Asia/Tehran). */
export function todayJalali(timeZone = "Asia/Tehran"): JalaliDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return toJalali(get("year"), get("month"), get("day"));
}

/**
 * Which weekday column (0 = شنبه/Saturday … 6 = جمعه/Friday) the given Jalali
 * date falls in — the layout the Persian calendar grid uses.
 */
export function jalaliWeekdayColumn(jy: number, jm: number, jd: number): number {
  const { gy, gm, gd } = toGregorian(jy, jm, jd);
  // getUTCDay: 0 = Sunday … 6 = Saturday. Shift so Saturday = 0.
  return (new Date(Date.UTC(gy, gm - 1, gd)).getUTCDay() + 1) % 7;
}
