/**
 * The Accounting app's section routing.
 *
 * The app used to live at `/dashboard/ledger` as one page of in-page tabs
 * (`?tab=` targets). It is now a real app with one route per section under its
 * own prefix — the same shape `crm-routes.ts` and `growth-routes.ts` keep — so
 * an accounting section is a URL a person can bookmark, share and pin, and the
 * app answers to its own name in the address bar: `/dashboard/accounting/…`,
 * the persons directory at `/dashboard/accounting/directory` among them.
 *
 * These keys are the one source of truth for the app's menu
 * (`accounting-nav.ts` labels them and draws their role line), for the
 * server-side gate on each page, and for the legacy `?tab=` redirects
 * (`/dashboard/ledger` still forwards here so old bookmarks, saved bottom-nav
 * slots and knowledge-base articles never become dead ends).
 */

/** The app's own home — the workspace rail, the sidebar parent and every "open accounting" link point here. */
export const ACCOUNTING_HOME = "/dashboard/accounting";

export const ACCOUNTING_SECTION_KEYS = [
  "dashboard",
  "trial-balance",
  "entries",
  "manual",
  "expenses",
  "fiscal-periods",
  // Accounting's own persons directory — the shared «اشخاص» record seen with
  // the ledger's columns (accounting code, tax), managed here rather than by
  // sending the accountant into the CRM.
  "directory",
  // The customers-only slice of the same record: the destination the A/R
  // customer actions point at, so an accountant looking at a receivable lands
  // on the customers they can settle with — never on a CRM redirect.
  "customers",
  "ar",
  "ap",
  "receipts",
  "installments",
  "cheques",
  "reconciliation",
  "chart-of-accounts",
  "payroll",
  "vat",
  "fixed-assets",
  "growth",
] as const;

export type AccountingSectionKey = (typeof ACCOUNTING_SECTION_KEYS)[number];

/** The route for a section. The dashboard is the app root; the rest nest under it. */
export function accountingSectionHref(key: AccountingSectionKey): string {
  return key === "dashboard" ? ACCOUNTING_HOME : `/dashboard/accounting/${key}`;
}

/** The full customers slice — Accounting's own customer directory. */
export function accountingCustomersHref(): string {
  return accountingSectionHref("customers");
}

/** One customer in Accounting's customers slice, with the party file opened. */
export function accountingCustomerHref(customerId: string): string {
  return `${accountingSectionHref("customers")}?party=${encodeURIComponent(customerId)}`;
}

/**
 * The `?tab=` key an old `/dashboard/ledger` link carried, answered with the
 * section it names now. `parties` is the one rename — it is the persons
 * directory, and the route says so. An unknown or missing tab is the app's
 * home, which is what the bare `/dashboard/ledger` always landed on.
 */
export function accountingSectionForLegacyTab(tab: string | null | undefined): AccountingSectionKey {
  if (tab === "parties") return "directory";
  return isAccountingSectionKey(tab) ? tab : "dashboard";
}

export function isAccountingSectionKey(value: string | null | undefined): value is AccountingSectionKey {
  return typeof value === "string" && (ACCOUNTING_SECTION_KEYS as readonly string[]).includes(value);
}

/** The app's own door — owner, manager and accountant, the same line the page gate draws. */
export function canOpenAccounting(role: string | null | undefined): boolean {
  return ["owner", "manager", "accountant"].includes(role ?? "");
}

/**
 * Where to send someone who lands on a section they may not open: back to the
 * app's own dashboard rather than out of the app entirely — being bounced to
 * `/dashboard` from a page they were linked to reads as a bug, not a
 * permission (the same line `crmFallbackHref` draws). (Whether a role may open
 * a section at all is `canViewAccountingSection` in `accounting-nav.ts`, the
 * one place the payroll line is drawn.)
 */
export function accountingFallbackHref(): string {
  return ACCOUNTING_HOME;
}

/**
 * Whether a dashboard path is a given section — the sidebar's idea of "you are
 * here". The dashboard is the app root, so it matches exactly and nothing
 * else; every other section also owns what nests under it.
 */
export function isAccountingSectionPathname(pathname: string, key: AccountingSectionKey): boolean {
  const href = accountingSectionHref(key);
  return key === "dashboard"
    ? pathname === href
    : pathname === href || pathname.startsWith(`${href}/`);
}
