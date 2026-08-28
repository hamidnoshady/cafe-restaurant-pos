/**
 * Phase 35 Wave 5 — tool routing by app.
 *
 * `src/lib/ai-tools.ts` is 1278 lines of tool definitions, and ALL of them
 * are sent every turn. For "how much did we sell yesterday?" the gold weight,
 * watch repair and cosmetics batch-expiry tools go along for the ride.
 *
 * This module maps tools to apps, so a turn that only touches "sales" sends
 * only sales tools + the always-on set. Three guards protect against
 * misrouting:
 *
 * 1. Always-on tools are never filtered out.
 * 2. An uncertain router sends everything (fallback to today's behavior).
 * 3. The router's own cost is counted in the turn's settlement.
 *
 * Framework-free (no `db`, no `next`).
 */
import type { AppKey } from "./apps";

/**
 * Tools that must always be present regardless of routing. These are the
 * tools that the Phase 33 rules depend on ("before you say something doesn't
 * exist, call describe_app") and the generic reporting entry points.
 */
const ALWAYS_ON_TOOLS = new Set([
  "list_reports",
  "run_report",
  "find_items",
  "describe_app",
  "propose_action",
  "draft_expense_from_receipt",
  "get_bill_split_preview",
  "run_accounting_review",
]);

/**
 * Map from tool name to the app that owns it. Tools not in this map and not
 * in ALWAYS_ON_TOOLS are assumed to be general-purpose and always included.
 */
const TOOL_APP_MAP: Record<string, AppKey> = {
  // Sales app
  "get_menu_performance": "sales",
  "get_void_pattern": "sales",
  "get_waste_history": "sales",
  "get_stock_valuation": "sales",
  "get_supplier_performance": "sales",

  // Growth app
  "get_repurchase_candidates": "growth",
  "get_staff_commission": "growth",
  "get_customer_profile": "growth",
  "get_at_risk_customers": "growth",

  // Operations app
  "get_reservation_conflicts": "operations",
  "get_table_turnover_rate": "operations",
  "get_courier_performance": "operations",
  "get_near_expiry_items": "operations",

  // Accounting app
  "get_ar_aging": "accounting",
  "get_ap_upcoming": "accounting",
  "get_unreconciled_bank_lines": "accounting",
  "get_payroll_summary": "accounting",
  "get_vat_liability": "accounting",
  "get_branch_comparison": "accounting",
  "forecast_demand": "accounting",
};

/**
 * Pure: filters tool names to only those relevant for the given apps.
 * Returns null if routing should be skipped (uncertain → send everything).
 */
export function routeTools(
  allToolNames: string[],
  apps: AppKey[] | null | undefined,
): string[] | null {
  // No apps specified → uncertain → send everything
  if (!apps || apps.length === 0) return null;

  const appSet = new Set(apps);
  const result: string[] = [];

  for (const name of allToolNames) {
    // Always-on tools are never filtered
    if (ALWAYS_ON_TOOLS.has(name)) {
      result.push(name);
      continue;
    }

    // Tools not in the map are general-purpose → always included
    const owningApp = TOOL_APP_MAP[name];
    if (!owningApp) {
      result.push(name);
      continue;
    }

    // Include if the owning app is in scope
    if (appSet.has(owningApp)) {
      result.push(name);
    }
  }

  return result;
}

/**
 * Pure: whether a tool is always-on (must never be filtered).
 */
export function isAlwaysOnTool(name: string): boolean {
  return ALWAYS_ON_TOOLS.has(name);
}

/**
 * Pure: which app owns a tool, or null if it's general-purpose.
 */
export function appForTool(name: string): AppKey | null {
  return TOOL_APP_MAP[name] ?? null;
}
