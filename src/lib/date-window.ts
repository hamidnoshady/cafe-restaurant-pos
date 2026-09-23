/**
 * Rolling date windows over the repo's storage date shape (ISO/Gregorian
 * `YYYY-MM-DD` — Shamsi is a display concern).
 *
 * `crm-shared.ts` and `growth-shared.ts` each carried a byte-identical
 * `rollingWindow`, and the CRM's copy openly admitted it ("matching
 * `growth-shared.ts`"). Two copies of a date calculation is two places for an
 * off-by-one to be fixed in only one of them, and both were already carrying
 * their own test suite proving the same three cases. Neither app owns the idea
 * of "the last 30 days", so it lives here and both re-export it — the same
 * reason `iso-date.ts` exists rather than each service re-deriving month
 * lengths.
 */

/**
 * A rolling N-day window ending on `today`, inclusive at both ends.
 *
 * Rolling rather than calendar-month: a number means the same thing on any day
 * it is opened, instead of being tiny on the first of the month.
 */
export function rollingWindow(today: string, days = 30): { from: string; to: string } {
  const to = new Date(`${today}T00:00:00Z`);
  to.setUTCDate(to.getUTCDate() - (days - 1));
  return { from: to.toISOString().slice(0, 10), to: today };
}

/** The window immediately before `window`, of the same length — for period-over-period comparison. */
export function previousWindow(window: { from: string; to: string }): { from: string; to: string } {
  const from = new Date(`${window.from}T00:00:00Z`);
  const to = new Date(`${window.to}T00:00:00Z`);
  const lengthDays = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
  const priorTo = new Date(from);
  priorTo.setUTCDate(priorTo.getUTCDate() - 1);
  const priorFrom = new Date(priorTo);
  priorFrom.setUTCDate(priorFrom.getUTCDate() - (lengthDays - 1));
  return { from: priorFrom.toISOString().slice(0, 10), to: priorTo.toISOString().slice(0, 10) };
}
