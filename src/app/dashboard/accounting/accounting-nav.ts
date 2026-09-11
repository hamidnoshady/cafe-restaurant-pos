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
  { key: "directory", label: "اشخاص" },
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

/** The sections a role may open — the same list the sidebar and the rail draw. */
export function accountingSectionsForRole(role: string | null | undefined): AccountingSectionDef[] {
  if (!(ACCOUNTING_ROLES as readonly string[]).includes(role ?? "")) return [];
  return ACCOUNTING_SECTIONS.filter((section) => !section.roles || section.roles.includes(role ?? ""));
}

/** Whether a given role may open a section — the page gate and the menu agree by construction. */
export function canViewAccountingSection(role: string | null | undefined, key: AccountingSectionKey): boolean {
  return accountingSectionsForRole(role).some((section) => section.key === key);
}
