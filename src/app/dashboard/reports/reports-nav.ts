/**
 * The «گزارش‌ها» section list — the reports sub-menu.
 *
 * Reports are one in-page tabbed workspace (`/dashboard/reports`), so like the
 * ledger they are query-string targets. Kept framework-free so the sidebar
 * (`layout.tsx`) and the in-page rail (`reports-manager.tsx`) read the same
 * list and never disagree about what «گزارش‌ها» contains.
 */

export const REPORTS_TAB_KEYS = ["standard", "shift-orders", "builder", "growth", "branches"] as const;
export type ReportsTabKey = (typeof REPORTS_TAB_KEYS)[number];

export interface ReportsTabDef {
  key: ReportsTabKey;
  label: string;
  /** Omitted means the page's own door — owner/manager/accountant. */
  roles?: string[];
}

export const REPORTS_TABS: readonly ReportsTabDef[] = [
  { key: "standard", label: "گزارش‌های آماده" },
  { key: "shift-orders", label: "سفارش‌های شیفت" },
  { key: "builder", label: "گزارش‌ساز" },
  { key: "growth", label: "رشد و بازاریابی" },
  // Owner-only: matches /api/reports/business-overview's guard.
  { key: "branches", label: "مقایسهٔ شعب", roles: ["owner"] },
];

/**
 * The route for a section. Every entry is an explicit `?tab=` target — the
 * first tab included — so the sidebar can tell «گزارش‌های آماده» apart from a
 * sibling tab; the bare `/dashboard/reports` still lands on the first tab.
 */
export function reportsTabHref(key: ReportsTabKey): string {
  return `/dashboard/reports?tab=${key}`;
}

/** The app's own door — `reports/page.tsx` refuses everyone else. */
const REPORTS_ROLES = ["owner", "manager", "accountant"];

/** The sections a role may open — mirrors the page's own role gate. */
export function reportsTabsForRole(role: string | null | undefined): ReportsTabDef[] {
  if (!REPORTS_ROLES.includes(role ?? "")) return [];
  return REPORTS_TABS.filter((tab) => !tab.roles || tab.roles.includes(role ?? ""));
}

export function isReportsTabKey(value: string | null | undefined): value is ReportsTabKey {
  return typeof value === "string" && (REPORTS_TAB_KEYS as readonly string[]).includes(value);
}
