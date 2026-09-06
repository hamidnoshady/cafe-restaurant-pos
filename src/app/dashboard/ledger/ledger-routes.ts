/**
 * The Accounting app's route helpers.
 *
 * The ledger is one in-app tabbed workspace (`/dashboard/ledger`), so these are
 * query-string targets rather than page paths. They are kept in one place so the
 * A/R customer actions and the general party links cannot drift apart: both point
 * at the same `?tab=` the `LedgerManager` reads.
 */

/** The full customers slice — Accounting's own customer directory. */
export function accountingCustomersHref(): string {
  return "/dashboard/ledger?tab=customers";
}

/** One customer in Accounting's customers slice, with the party file opened. */
export function accountingCustomerHref(customerId: string): string {
  return `/dashboard/ledger?tab=customers&party=${encodeURIComponent(customerId)}`;
}
