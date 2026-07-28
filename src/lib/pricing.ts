/**
 * Cost-plus menu pricing (pure math — DB lookups for material cost, overhead
 * rate, and margin live in pricing-service.ts).
 */
import type { Rial } from "./money";

export interface SuggestedPriceInput {
  /** Recipe cost: Σ ingredient quantity × current unit cost, integer Rial. */
  materialCost: Rial;
  /** Overhead recovery rate as a percent of material cost (e.g. 40 = 40%); null when there's no revenue history to derive it from. */
  overheadRatePercent: number | null;
  /** Target gross margin as a percent of the selling price (e.g. 30 = 30%); null when neither an item override nor a business default is configured. */
  marginPercent: number | null;
}

export interface SuggestedPriceResult {
  /** Material cost with overhead folded in (overhead treated as 0 when unknown). */
  loadedCost: Rial;
  /** loadedCost / (1 - margin%), rounded to the nearest Toman; null when marginPercent is null. */
  suggestedPrice: Rial | null;
}

/**
 * suggestedPrice lands margin% on the *selling price* (gross margin — the
 * same definition getProfitAndLoss's grossProfit/totalRevenue uses), not
 * markup-on-cost, so a business's target margin setting means the same
 * thing here as it does on the P&L.
 */
export function computeSuggestedPrice({
  materialCost,
  overheadRatePercent,
  marginPercent,
}: SuggestedPriceInput): SuggestedPriceResult {
  const loadedCost = Math.round(materialCost * (1 + (overheadRatePercent ?? 0) / 100));
  if (marginPercent == null) return { loadedCost, suggestedPrice: null };
  const raw = loadedCost / (1 - marginPercent / 100);
  return { loadedCost, suggestedPrice: Math.round(raw / 10) * 10 };
}
