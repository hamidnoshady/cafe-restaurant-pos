/**
 * The Accounting app's section list (the «حسابداری» sub-menu).
 *
 * The ledger is one tabbed workspace (`/dashboard/ledger`), so these are
 * query-string targets rather than page paths — the same shape
 * `product-workspace.ts` keeps for «محصولات». They are kept in one
 * framework-free place (no React, no JSX, no icons) so the *sidebar*
 * (built server-side in `layout.tsx`) and the in-page tab rail
 * (`ledger-manager.tsx`, a client component) read the same list and can never
 * disagree about what «حسابداری» contains or what each section is called.
 *
 * The dashboard is the app's home: it is the first entry, and the bare
 * `/dashboard/ledger` route lands on it (no `?tab=`), the way the CRM and
 * Growth apps land on their own میز کار.
 */

export const LEDGER_TAB_KEYS = [
  "dashboard",
  "trial-balance",
  "entries",
  "manual",
  "expenses",
  "fiscal-periods",
  "parties",
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
export type LedgerTabKey = (typeof LEDGER_TAB_KEYS)[number];

export interface LedgerTabDef {
  key: LedgerTabKey;
  label: string;
  /**
   * The roles that may open this section. Omitted means the app's own door —
   * owner/manager/accountant — which `ledger/page.tsx` already enforces.
   */
  roles?: string[];
}

export const LEDGER_TABS: readonly LedgerTabDef[] = [
  { key: "dashboard", label: "داشبورد حسابداری" },
  { key: "trial-balance", label: "تراز آزمایشی" },
  { key: "entries", label: "دفتر روزنامه" },
  { key: "manual", label: "ثبت سند دستی" },
  { key: "expenses", label: "هزینه‌ها" },
  { key: "fiscal-periods", label: "دوره‌های مالی" },
  { key: "parties", label: "اشخاص" },
  { key: "customers", label: "مشتریان" },
  { key: "ar", label: "حساب‌های دریافتنی" },
  { key: "ap", label: "حساب‌های پرداختنی" },
  { key: "receipts", label: "دریافت و پرداخت" },
  { key: "installments", label: "اقساط" },
  { key: "cheques", label: "چک‌ها" },
  { key: "reconciliation", label: "تطبیق بانکی" },
  { key: "chart-of-accounts", label: "سرفصل حساب‌ها" },
  // Wages are compensation data — owner + accountant only, the same line the
  // in-page rail draws. A manager may open every other section.
  { key: "payroll", label: "حقوق و دستمزد", roles: ["owner", "accountant"] },
  { key: "vat", label: "گزارش مالیات" },
  { key: "fixed-assets", label: "دارایی‌های ثابت" },
  { key: "growth", label: "رشد و بازاریابی" },
];

/**
 * The route for a section. Every entry is an explicit `?tab=` target — the
 * dashboard included — so the sidebar can tell «داشبورد حسابداری» apart from
 * a sibling tab; the bare `/dashboard/ledger` still lands on the dashboard
 * (the first tab), which is the app's home.
 */
export function ledgerTabHref(key: LedgerTabKey): string {
  return `/dashboard/ledger?tab=${key}`;
}

/** The app's own door — `ledger/page.tsx` refuses everyone else. */
const LEDGER_ROLES = ["owner", "manager", "accountant"];

/** The sections a role may open — mirrors the page's own role gate. */
export function ledgerTabsForRole(role: string | null | undefined): LedgerTabDef[] {
  if (!LEDGER_ROLES.includes(role ?? "")) return [];
  return LEDGER_TABS.filter((tab) => !tab.roles || tab.roles.includes(role ?? ""));
}

export function isLedgerTabKey(value: string | null | undefined): value is LedgerTabKey {
  return typeof value === "string" && (LEDGER_TAB_KEYS as readonly string[]).includes(value);
}
