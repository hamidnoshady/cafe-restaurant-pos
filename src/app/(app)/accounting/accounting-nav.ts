/**
 * The Accounting app's section list (the «حسابداری» sub-menu).
 *
 * Every section is a real route now (`accounting-routes.ts` answers the path),
 * so this file carries what a menu and a gate need: what each section is
 * *called*, and the roles that may open it. The same list is read by the
 * dashboard's sidebar (built server-side in `layout.tsx`) and the in-page rail
 * (`accounting-manager.tsx`, a client component), so the two can never
 * disagree about what «حسابداری» contains or what each section is called.
 *
 * It stays framework-free (no React, no JSX, no icons) for that reason; the
 * manager keeps its own icon map, the way `crm-nav.ts` does.
 */

import type { AccountingSectionKey } from "./accounting-routes";

/** The app's own door — owner, manager and accountant, the line every page draws. */
export const ACCOUNTING_ROLES = ["owner", "manager", "accountant"] as const;

export interface AccountingSectionDef {
  key: AccountingSectionKey;
  label: string;
  /**
   * The roles that may open this section. Omitted means the app's own door
   * (`ACCOUNTING_ROLES`), which the page gate already enforces.
   */
  roles?: readonly string[];
}

/** The app's sections, in menu order. The dashboard (the app's home) is first. */
export const ACCOUNTING_SECTIONS: readonly AccountingSectionDef[] = [
  { key: "dashboard", label: "داشبورد حسابداری" },
  { key: "trial-balance", label: "تراز آزمایشی" },
  { key: "entries", label: "دفتر روزنامه" },
  { key: "manual", label: "ثبت سند دستی" },
  { key: "expenses", label: "هزینه‌ها" },
  { key: "fiscal-periods", label: "دوره‌های مالی" },
  // The platform's one people directory. «مشتریان»، «تأمین‌کنندگان» and
  // «فروشندگان» were three more sections here; they are `?view=` filters of
  // this one now (`src/lib/party-directory.ts`), so there is one screen, one
  // add/edit form and one place every deep link lands.
  { key: "directory", label: "اشخاص" },
  { key: "receivables", label: "حساب‌های دریافتنی" },
  { key: "payables", label: "حساب‌های پرداختنی" },
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
  { key: "reports", label: "گزارش‌های مالی" },
  { key: "growth", label: "رشد و بازاریابی" },
  // Accounting's *own* settings — never the platform settings page. Last in
  // the menu, the way every app's settings entry is.
  { key: "settings", label: "تنظیمات حسابداری" },
];

/**
 * How the *ledger rail* («فضای کار حسابداری», the in-page menu) divides those
 * sections.
 *
 * The app's **sidebar** is no longer this list: Accounting is the business's
 * primary workspace now, so its menu is composed in
 * `accounting-workspace.ts` — the business's work areas plus these sections
 * gathered into one group. This grouping stays because the in-page rail still
 * draws it, and because it is the one place that guarantees every section has
 * a home.
 *
 * Twenty-three rows in one column is a list nobody reads; these are the
 * accountant's own divisions of the work. Every key appears in exactly one
 * group — asserted in `accounting-nav.test.ts`, so a section added to
 * `ACCOUNTING_SECTIONS` without a home here fails the build rather than
 * quietly vanishing from the menu.
 */
export const ACCOUNTING_NAV_GROUPS: readonly { label: string; keys: readonly AccountingSectionKey[] }[] = [
  { label: "دفتر", keys: ["dashboard", "trial-balance", "entries", "manual", "chart-of-accounts"] },
  { label: "اشخاص", keys: ["directory"] },
  { label: "دریافتنی و پرداختنی", keys: ["receivables", "payables", "installments", "cheques"] },
  { label: "وجوه و هزینه", keys: ["receipts", "expenses", "reconciliation", "fixed-assets"] },
  { label: "دوره و گزارش", keys: ["fiscal-periods", "vat", "payroll", "reports", "growth"] },
  // The app's settings entry, last — the shape every app's menu ends with.
  { label: "پیکربندی", keys: ["settings"] },
];

/** The sections a role may open — the same list the sidebar and the rail draw. */
export function accountingSectionsForRole(role: string | null | undefined): AccountingSectionDef[] {
  if (!(ACCOUNTING_ROLES as readonly string[]).includes(role ?? "")) return [];
  return ACCOUNTING_SECTIONS.filter((section) => !section.roles || section.roles.includes(role ?? ""));
}

/** Whether a given role may open a section — the page gate and the menu agree by construction. */
export function canViewAccountingSection(role: string | null | undefined, key: AccountingSectionKey): boolean {
  return accountingSectionsForRole(role).some((section) => section.key === key);
}
