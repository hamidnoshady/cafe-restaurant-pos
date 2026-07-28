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

const OVERHEAD_LOOKBACK_DAYS = 30;

export interface PricingConfig {
  /** Business-wide target gross margin (%), applied to any item without its own override. Null until an owner sets one. */
  defaultMarginPercent: number | null;
  /**
   * Manually estimated overhead (%), used only until the ledger has 30 days
   * of real revenue to derive a rate from — a new business (or one that's
   * posted rent/setup expenses before its first sale) would otherwise get
   * suggestions with zero overhead baked in, since there's nothing to divide
   * by yet. Ignored the moment the ledger-derived rate becomes available.
   */
  fallbackOverheadPercent: number | null;
}

export async function getPricingConfig(businessId: string): Promise<PricingConfig> {
  const stored = await getSetting<PricingConfig>(businessId, SETTING_KEYS.pricing);
  return {
    defaultMarginPercent: stored?.defaultMarginPercent ?? null,
    fallbackOverheadPercent: stored?.fallbackOverheadPercent ?? null,
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
    `SELECT price, target_margin_percent FROM menu_items WHERE id = $1`,
    [menuItemId],
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
  const pnl = await getProfitAndLoss(businessId, { dateFrom: addDays(dateTo, -OVERHEAD_LOOKBACK_DAYS), dateTo });
  const ledgerOverheadRatePercent =
    pnl.totalRevenue > 0 ? ((pnl.operatingExpenses + pnl.laborCost) / pnl.totalRevenue) * 100 : null;
  const overheadRatePercent = ledgerOverheadRatePercent ?? config.fallbackOverheadPercent;
  const overheadSource: SuggestedPriceBreakdown["overheadSource"] =
    ledgerOverheadRatePercent != null ? "ledger" : config.fallbackOverheadPercent != null ? "fallback" : "none";

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
