/**
 * The Accounting app's section routing.
 *
 * The app used to live at `/dashboard/ledger` as one page of in-page tabs
 * (`?tab=` targets), then under `/dashboard/accounting`. It is now a real app
 * at its own top-level public prefix — `/accounting/…`, a real route directory
 * under `src/app/(app)/accounting`, not a middleware rewrite — with one route
 * per section, so an accounting section is a URL a person can bookmark, share
 * and pin.
 *
 * These keys are the one source of truth for the app's menu
 * (`accounting-nav.ts` labels them and draws their role line), for the
 * server-side gate on each page, and for the legacy `?tab=` redirects
 * (`/dashboard/ledger` still forwards here so old bookmarks, saved bottom-nav
 * slots and knowledge-base articles never become dead ends).
 */

/** The app's own home — the workspace rail, the sidebar parent and every "open accounting" link point here. */
export const ACCOUNTING_HOME = "/accounting/overview";

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
  // The supplier-side slices of that same shared record. «تأمین‌کنندگان» is
  // the buying relationship the payables settle against; «فروشندگان» is the
  // same record under the word an accountant coming from another package
  // looks for. Both read one `parties` row — see the note on `vendors` in
  // `accounting-nav.ts`: an alias view, never a second store.
  "suppliers",
  "vendors",
  // Receivables and payables. The keys used to be `ar`/`ap`; the public URLs
  // say what they are, and the two initialisms still resolve (see
  // `accountingSectionForLegacyKey`).
  "receivables",
  "payables",
  "receipts",
  "installments",
  "cheques",
  "reconciliation",
  "chart-of-accounts",
  "payroll",
  "vat",
  "fixed-assets",
  // The app's own report index — the accounting reports, from inside
  // Accounting, rather than sending the accountant to the business's reports
  // workspace to find them.
  "reports",
  "growth",
  // Accounting's *own* settings, last — the shape every app's menu ends with.
  // Deliberately not the platform settings page: `/settings` is the platform
  // area, `/accounting/settings` is this app's.
  "settings",
] as const;

export type AccountingSectionKey = (typeof ACCOUNTING_SECTION_KEYS)[number];

/** The route for a section. The dashboard is the app root; the rest nest under it. */
export function accountingSectionHref(key: AccountingSectionKey): string {
  return key === "dashboard" ? ACCOUNTING_HOME : `/accounting/${key}`;
}

/** Accounting's own settings page — never the platform settings page. */
export const ACCOUNTING_SETTINGS_HREF = "/accounting/settings";

/** The full customers slice — Accounting's own customer directory. */
export function accountingCustomersHref(): string {
  return accountingSectionHref("customers");
}

/** One customer in Accounting's customers slice, with the party file opened. */
export function accountingCustomerHref(customerId: string): string {
  return `${accountingSectionHref("customers")}?party=${encodeURIComponent(customerId)}`;
}

/**
 * Section keys that used to be spelled differently, and what they are now.
 *
 * `ar`/`ap` were the ledger's initialisms; the routes say «receivables» and
 * «payables». `parties` was the old `?tab=` name of the persons directory.
 * Every one of them still resolves rather than 404-ing.
 */
const LEGACY_SECTION_ALIASES: Record<string, AccountingSectionKey> = {
  ar: "receivables",
  ap: "payables",
  parties: "directory",
};

/** The section an old key names now, or null when it is not an old key. */
export function accountingSectionForLegacyKey(
  key: string | null | undefined,
): AccountingSectionKey | null {
  if (typeof key !== "string") return null;
  return LEGACY_SECTION_ALIASES[key] ?? null;
}

/**
 * The `?tab=` key an old `/dashboard/ledger` link carried, answered with the
 * section it names now. An unknown or missing tab is the app's home, which is
 * what the bare `/dashboard/ledger` always landed on.
 */
export function accountingSectionForLegacyTab(tab: string | null | undefined): AccountingSectionKey {
  const alias = accountingSectionForLegacyKey(tab);
  if (alias) return alias;
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
