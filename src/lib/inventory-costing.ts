/**
 * Inventory costing — pure functions, integer Rial in/out (fractional
 * quantities are fine; money stays integer).
 *
 * Single strategy interface (`InventoryCostingStrategy.calculateCOGS`)
 * behind two implementations, selected by the locked setup-wizard choice
 * (`inventory.costing` setting, see setup-state.ts):
 *
 *   - FIFO: consumes the oldest open lot(s) first. Needs the caller's lots
 *     sorted oldest-received-first; each lot's `remainingQty` is drawn down
 *     until the required quantity is satisfied.
 *   - Weighted average: no lots involved — every unit costs the item's
 *     current running `avg_cost` (see calculateNewAverageCost, applied on
 *     each purchase receipt).
 *
 * If FIFO lots run out before the required quantity is met (recorded stock
 * doesn't cover what's being deducted — e.g. missed a purchase entry), the
 * shortfall is still costed, at the last-consumed lot's cost (or the
 * fallback cost if no lots existed at all), so completing an order is never
 * blocked by a bookkeeping gap. The shortfall is reported back so callers
 * can flag it rather than silently going negative.
 */
import type { Rial } from "./money";

export interface Lot {
  id: string;
  remainingQty: number;
  unitCost: Rial;
}

export interface ConsumptionLine {
  /** null = shortfall consumed at fallback cost, no lot to draw down */
  lotId: string | null;
  quantity: number;
  unitCost: Rial;
  lineCost: Rial;
}

export interface ConsumptionResult {
  lines: ConsumptionLine[];
  totalCost: Rial;
  /** quantity that had no lot/stock to back it, already included in totalCost */
  shortfall: number;
}

export interface InventoryCostingStrategy {
  /**
   * `lots` must already be sorted in consumption order (oldest first for
   * FIFO); ignored by weighted-average. `fallbackUnitCost` prices any
   * shortfall (FIFO) or the entire quantity (weighted-average, where it's
   * the item's avg_cost).
   */
  calculateCOGS(lots: Lot[], quantityNeeded: number, fallbackUnitCost: Rial): ConsumptionResult;
}

function roundCost(value: number): Rial {
  return Math.round(value);
}

export const fifoCostingStrategy: InventoryCostingStrategy = {
  calculateCOGS(lots, quantityNeeded, fallbackUnitCost) {
    const lines: ConsumptionLine[] = [];
    let remaining = quantityNeeded;
    let totalCost = 0;
    let lastUnitCost = fallbackUnitCost;

    for (const lot of lots) {
      if (remaining <= 0) break;
      if (lot.remainingQty <= 0) continue;
      const take = Math.min(lot.remainingQty, remaining);
      const lineCost = roundCost(take * lot.unitCost);
      lines.push({ lotId: lot.id, quantity: take, unitCost: lot.unitCost, lineCost });
      totalCost += lineCost;
      remaining -= take;
      lastUnitCost = lot.unitCost;
    }

    const shortfall = Math.max(remaining, 0);
    if (shortfall > 0) {
      const lineCost = roundCost(shortfall * lastUnitCost);
      lines.push({ lotId: null, quantity: shortfall, unitCost: lastUnitCost, lineCost });
      totalCost += lineCost;
    }

    return { lines, totalCost, shortfall };
  },
};

export const weightedAverageCostingStrategy: InventoryCostingStrategy = {
  calculateCOGS(_lots, quantityNeeded, fallbackUnitCost) {
    const lineCost = roundCost(quantityNeeded * fallbackUnitCost);
    return {
      lines: [{ lotId: null, quantity: quantityNeeded, unitCost: fallbackUnitCost, lineCost }],
      totalCost: lineCost,
      shortfall: 0,
    };
  },
};

export type CostingMethod = "fifo" | "weighted_average";

export function getCostingStrategy(method: CostingMethod): InventoryCostingStrategy {
  return method === "fifo" ? fifoCostingStrategy : weightedAverageCostingStrategy;
}

/**
 * New running weighted-average unit cost after receiving `incomingQty` at
 * `incomingUnitCost`, given the current on-hand `existingQty` at
 * `existingAvgCost`. If there's no prior stock, the new cost is simply the
 * incoming unit cost.
 */
export function calculateNewAverageCost(
  existingQty: number,
  existingAvgCost: Rial,
  incomingQty: number,
  incomingUnitCost: Rial,
): Rial {
  const totalQty = existingQty + incomingQty;
  if (totalQty <= 0) return incomingUnitCost;
  const totalValue = existingQty * existingAvgCost + incomingQty * incomingUnitCost;
  return roundCost(totalValue / totalQty);
}
