/**
 * Pure input rules for «ثبت هزینه» (expense management).
 *
 * Kept out of `expense-service.ts` (which touches the DB and therefore has no
 * unit test, per repo convention) so the validation the form and the API both
 * depend on can be unit-tested: an expense date that is not a real calendar
 * date used to reach Postgres as raw text and blow up as an unhandled 500, and
 * the list endpoint had no filters at all while silently truncating at 200
 * rows.
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A well-formed *and* real ISO calendar date (rejects 2025-02-31, 2025-13-01, …). */
export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
  );
}

/** Rial amounts are stored in a BIGINT column but calculated as JS numbers. */
export const MAX_EXPENSE_AMOUNT_RIAL = Number.MAX_SAFE_INTEGER;

export interface ExpenseListFilters {
  dateFrom: string | null;
  dateTo: string | null;
  accountId: string | null;
  paymentAccountId: string | null;
  q: string | null;
  limit: number;
}

export const EXPENSE_LIST_DEFAULT_LIMIT = 100;
export const EXPENSE_LIST_MAX_LIMIT = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Normalise the list query. Everything is optional; anything malformed is
 * dropped rather than rejected, because a filter bar should narrow a list, not
 * error it out. Dates that arrive reversed are swapped — «از» after «تا» is a
 * mis-click, not an empty result.
 */
export function parseExpenseListQuery(params: URLSearchParams): ExpenseListFilters {
  const iso = (key: string) => {
    const value = params.get(key);
    return isValidIsoDate(value) ? value : null;
  };
  let dateFrom = iso("dateFrom");
  let dateTo = iso("dateTo");
  if (dateFrom && dateTo && dateFrom > dateTo) [dateFrom, dateTo] = [dateTo, dateFrom];

  const uuid = (key: string) => {
    const value = params.get(key)?.trim() ?? "";
    return UUID_RE.test(value) ? value : null;
  };

  const requested = Number(params.get("limit"));
  const limit =
    Number.isInteger(requested) && requested > 0
      ? Math.min(requested, EXPENSE_LIST_MAX_LIMIT)
      : EXPENSE_LIST_DEFAULT_LIMIT;

  return {
    dateFrom,
    dateTo,
    accountId: uuid("accountId"),
    paymentAccountId: uuid("paymentAccountId"),
    q: params.get("q")?.trim() || null,
    limit,
  };
}
