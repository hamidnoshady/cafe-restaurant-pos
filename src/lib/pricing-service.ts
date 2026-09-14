/**
 * Cost-plus pricing orchestration (DB-touching, not unit-tested directly per
 * repo convention — the math lives in pricing.ts and is what pricing.test.ts
 * covers). Ties together three things nothing in the codebase previously
 * connected: a menu item's recipe (menu_item_ingredients × inventory_items'
 * running avg_cost) for material cost, the ledger's P&L for an overhead
 * recovery rate, and a target gross margin (per-item override, else the
 * business default) — see computeSuggestedPrice.
 */
import type { Rial } from "./money";
import { query } from "./db";
import { getSetting, setSetting, SETTING_KEYS } from "./settings";
import { getProfitAndLoss } from "./reports-service";
import { addDays } from "./rollup";
import { computeSuggestedPrice } from "./pricing";
import { recipeCostDrift } from "./cost-drift";

const OVERHEAD_LOOKBACK_DAYS = 30;

/** The default drift threshold, used only until an owner sets their own. */
export const DEFAULT_COST_DRIFT_THRESHOLD_PERCENT = 20;

export interface PricingConfig {
  /** Business-wide target gross margin (%), applied to any item without its own override. Null until an owner sets one. */
  defaultMarginPercent: number | null;
  /**
   * Manually estimated overhead (%), used only until the ledger has 30 days
   * of real revenue to derive a rate from — a new business (or one that's
   * posted rent/setup expenses before its first sale) would otherwise get
   * suggestions with zero overhead baked in, since there's nothing to divide
   * by yet. In automatic mode it is used until the ledger-derived rate is
   * available; in manual mode it remains active indefinitely.
   */
  fallbackOverheadPercent: number | null;
  /** Selects whether a configured estimate remains in use after ledger data is available. */
  overheadMode?: "automatic" | "manual";
  /** Phase 27 Wave 12 — flag a recipe whose ingredient cost rose this many percent or more. Optional: absent = the default. */
  costDriftThresholdPercent?: number;
}

export async function getPricingConfig(businessId: string): Promise<PricingConfig> {
  const stored = await getSetting<PricingConfig>(businessId, SETTING_KEYS.pricing);
  return {
    defaultMarginPercent: stored?.defaultMarginPercent ?? null,
    fallbackOverheadPercent: stored?.fallbackOverheadPercent ?? null,
    overheadMode: stored?.overheadMode === "manual" ? "manual" : "automatic",
    costDriftThresholdPercent: stored?.costDriftThresholdPercent ?? DEFAULT_COST_DRIFT_THRESHOLD_PERCENT,
  };
}

export async function setPricingConfig(businessId: string, config: PricingConfig): Promise<void> {
  await setSetting(businessId, SETTING_KEYS.pricing, config);
}

export interface SuggestedPriceBreakdown {
  materialCost: Rial;
  hasRecipe: boolean;
  /** Percent of material cost recovered as overhead — from the ledger when there's revenue to derive a rate from, else the manual fallback, else null. */
  overheadRatePercent: number | null;
  overheadSource: "ledger" | "fallback" | "none";
  loadedCost: Rial;
  marginPercent: number | null;
  marginSource: "item" | "default" | "none";
  /** Null whenever there's no recipe or no margin configured — a bare material cost of 0 is not a suggestion. */
  suggestedPrice: Rial | null;
  currentPrice: Rial;
}

export async function getSuggestedPrice(businessId: string, menuItemId: string): Promise<SuggestedPriceBreakdown | null> {
  const { rows: itemRows } = await query<{ price: string; target_margin_percent: string | null }>(
    `SELECT mi.price, mi.target_margin_percent
       FROM menu_items mi
       JOIN locations l ON l.id = mi.location_id
      WHERE mi.id = $1 AND l.business_id = $2`,
    [menuItemId, businessId],
  );
  const item = itemRows[0];
  if (!item) return null;

  const { rows: recipeRows } = await query<{ ingredient_count: string; cost: string }>(
    `SELECT count(*) AS ingredient_count, COALESCE(SUM(mi.quantity * ii.avg_cost), 0) AS cost
       FROM menu_item_ingredients mi
       JOIN inventory_items ii ON ii.id = mi.inventory_item_id
      WHERE mi.menu_item_id = $1`,
    [menuItemId],
  );
  const hasRecipe = Number(recipeRows[0].ingredient_count) > 0;
  const materialCost = Math.round(Number(recipeRows[0].cost));

  const config = await getPricingConfig(businessId);
  const dateTo = new Date().toISOString().slice(0, 10);
  const pnl = await getProfitAndLoss(businessId, { dateFrom: addDays(dateTo, -(OVERHEAD_LOOKBACK_DAYS - 1)), dateTo });
  const ledgerOverheadRatePercent =
    pnl.totalRevenue > 0 ? ((pnl.operatingExpenses + pnl.laborCost) / pnl.totalRevenue) * 100 : null;
  // A manual estimate is an intentional choice, not merely a bootstrap value.
  // Previously it was silently disabled as soon as a single revenue entry
  // existed, which made the setting misleading for owners who prefer their
  // own rate even after the 30-day ledger window is populated.
  const useLedgerOverhead = config.overheadMode !== "manual";
  const overheadRatePercent = useLedgerOverhead
    ? ledgerOverheadRatePercent ?? config.fallbackOverheadPercent
    : config.fallbackOverheadPercent;
  const overheadSource: SuggestedPriceBreakdown["overheadSource"] =
    useLedgerOverhead && ledgerOverheadRatePercent != null
      ? "ledger"
      : config.fallbackOverheadPercent != null
        ? "fallback"
        : "none";

  const itemMargin = item.target_margin_percent != null ? Number(item.target_margin_percent) : null;
  const marginPercent = itemMargin ?? config.defaultMarginPercent;
  const marginSource: SuggestedPriceBreakdown["marginSource"] =
    itemMargin != null ? "item" : config.defaultMarginPercent != null ? "default" : "none";

  const { loadedCost, suggestedPrice } = computeSuggestedPrice({ materialCost, overheadRatePercent, marginPercent });

  return {
    materialCost,
    hasRecipe,
    overheadRatePercent,
    overheadSource,
    loadedCost,
    marginPercent,
    marginSource,
    suggestedPrice: hasRecipe ? suggestedPrice : null,
    currentPrice: Number(item.price),
  };
}

export interface MenuCostDriftRow {
  menuItemId: string;
  name: string;
  currentCost: number;
  referenceCost: number;
  price: number;
  costChangePercent: number;
  oldMarginPercent: number;
  newMarginPercent: number;
}

/**
 * Phase 27 Wave 12 — menu items whose ingredient cost has risen past the
 * business's threshold since they were priced. The reference cost is the
 * material cost the current price implies at the item's target margin (or
 * the business default), so no price-history snapshot is required.
 */
export async function listMenuCostDrift(businessId: string, locationId: string): Promise<MenuCostDriftRow[]> {
  const config = await getPricingConfig(businessId);
  const { rows } = await query<{
    menu_item_id: string;
    name: string;
    price: string;
    target_margin_percent: string | null;
    current_cost: string;
  }>(
    `SELECT mi.id AS menu_item_id, mi.name, mi.price::text,
            mi.target_margin_percent::text,
            COALESCE(SUM(ing.quantity * ii.avg_cost), 0)::text AS current_cost
       FROM menu_items mi
       LEFT JOIN menu_item_ingredients ing ON ing.menu_item_id = mi.id
       LEFT JOIN inventory_items ii ON ii.id = ing.inventory_item_id
      WHERE mi.location_id = $1 AND mi.is_active
      GROUP BY mi.id, mi.name, mi.price, mi.target_margin_percent`,
    [locationId],
  );

  const marginPercent = (itemMargin: number | null) => itemMargin ?? config.defaultMarginPercent ?? 0;
  const out: MenuCostDriftRow[] = [];
  for (const r of rows) {
    const price = Number(r.price);
    const currentCost = Math.round(Number(r.current_cost));
    const referenceCost = Math.round(price * (1 - marginPercent(Number(r.target_margin_percent)) / 100));
    const drift = recipeCostDrift({
      currentCost,
      referenceCost,
      price,
      thresholdPercent: config.costDriftThresholdPercent ?? DEFAULT_COST_DRIFT_THRESHOLD_PERCENT,
    });
    if (!drift.drifted) continue;
    out.push({
      menuItemId: r.menu_item_id,
      name: r.name,
      currentCost,
      referenceCost,
      price,
      costChangePercent: Math.round(drift.costChangePercent),
      oldMarginPercent: Math.round(drift.oldMarginPercent),
      newMarginPercent: Math.round(drift.newMarginPercent),
    });
  }
  return out.sort((a, b) => b.costChangePercent - a.costChangePercent);
}
