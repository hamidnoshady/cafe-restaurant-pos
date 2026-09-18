/**
 * Calendar-aware validation of the repo's storage/wire date shape.
 *
 * Dates are stored and transported as ISO/Gregorian `YYYY-MM-DD` (Shamsi is a
 * display concern — see the "Shamsi-only dates" rule). Two checks are needed
 * before such a string reaches Postgres, and a shape test alone is not enough:
 *
 *  - `"banana"` and `"2026-13-45"` both reach a `date` column as
 *    `invalid input syntax for type date` (SQLSTATE 22007/22008), which the
 *    route layer has no code for — so the caller gets a 500 and the generic
 *    «خطای غیرمنتظره» instead of "that date is not valid".
 *  - A shape-only regex (`segments.isIsoDate`) happily passes `2026-02-31`,
 *    which Postgres then rejects for the same reason.
 *
 * `manual-journal-service.ts` grew this check first, for exactly that bug.
 * It lives here so every date-taking service shares one definition of "a
 * valid calendar date" rather than each re-deriving month lengths — the same
 * reason `role-labels.ts` exists.
 */

/** Gregorian leap year: divisible by 4, except centuries that aren't divisible by 400. */
export function isGregorianLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** How many days that Gregorian month has, or 0 when the month is out of range. */
export function gregorianMonthLength(year: number, month: number): number {
  const daysByMonth = [31, isGregorianLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return daysByMonth[month - 1] ?? 0;
}

/**
 * Is this a real calendar date written as `YYYY-MM-DD`?
 *
 * Rejects anything that is not a string, anything of another shape, and a
 * well-shaped date that does not exist (`2026-02-31`, `2026-13-01`).
 */
export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  return day <= gregorianMonthLength(year, month);
}

/**
 * Normalise an optional, user-supplied date into "a valid ISO date" or "none".
 *
 * `undefined`, `null` and a blank/whitespace string all mean "the service
 * decides" (today, via each caller's own `COALESCE(..., CURRENT_DATE)`), which
 * is why an empty string must NOT be forwarded: `''::date` is itself a cast
 * error. Anything else must be a real date — `{ ok: false }` says it is not,
 * and the caller raises its own domain error so the API answers 400 with a
 * code the UI can translate.
 */
export function normalizeOptionalIsoDate(
  value: unknown,
): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };
  if (!isValidIsoDate(trimmed)) return { ok: false };
  return { ok: true, value: trimmed };
}
