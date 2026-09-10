/**
 * Is this string shaped like a Postgres `uuid`?
 *
 * A guard, not a validator: every id in this schema is a `uuid`, so a request
 * body carrying anything else is asking about a row that cannot exist. The
 * reason it needs to be checked *before* the query is that `WHERE id = $1`
 * against a `uuid` column does not answer "no such row" for a non-uuid — it
 * raises `invalid input syntax for type uuid`, which surfaces as a 500 and the
 * generic «خطای غیرمنتظره».
 *
 * The concrete case: the A/R and A/P balance lists group unattributed journal
 * lines under the sentinel id `"unknown"` (see `UNKNOWN_CUSTOMER_KEY`), and any
 * picker built from those lists could hand that sentinel straight to a write
 * endpoint. Screens filter it out now; the services check it too, so the answer
 * is an honest 404 rather than a crash.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}
