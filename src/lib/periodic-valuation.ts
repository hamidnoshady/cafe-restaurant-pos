/**
 * سیستم ادواری — pure period-end valuation, no DB.
 *
 * Under the periodic system nothing is costed per movement. At period end
 * the user counts what is physically on hand and this module assigns that
 * count a value from the period's *cost layers* — the beginning inventory
 * (one layer, whatever last period's close said it was worth) followed by
 * each received purchase of the period in receipt order:
 *
 *   - weighted_average (میانگین موزون کلاسیک): one pooled unit cost,
 *     total layer value ÷ total layer quantity, applied to the whole count.
 *     This is the textbook end-of-period weighted average — distinct from
 *     the *moving* average the perpetual system keeps per receipt.
 *   - fifo (اولین صادره از اولین وارده، ادواری): what was sold left oldest-
 *     first, so what REMAINS is the newest layers. The count is valued by
 *     walking layers newest → oldest.
 *   - lifo (آخرین وارده، اولین صادره، ادواری): sales left newest-first, so
 *     what remains is the oldest layers. The count is valued oldest → newest.
 *
 * If the count exceeds every layer combined (more on hand than the books
 * bought — e.g. a missed purchase entry), the excess is valued at the last
 * layer's unit cost and reported back as `excessQty` so the caller can flag
 * it instead of silently absorbing it.
 *
 * All money is integer Rial (bigint in/out as decimal strings); quantities
 * are decimal strings. Rounding: each layer's contribution is proportional
 * to the quantity drawn from it, rounded half-up per layer.
 */
import Decimal from "decimal.js";

export interface PeriodCostLayer {
  /** decimal-string quantity received (or on hand at period start) */
  quantity: string;
  /** integer-Rial decimal string: the layer's total value */
  valueRial: string;
}

export interface EndingValuation {
  /** integer Rial as decimal string */
  endingValueRial: string;
  /** counted quantity that exceeded all layers combined ("0" when none) */
  excessQty: string;
}

export type PeriodicMethod = "fifo" | "lifo" | "weighted_average";

function layerUnitValue(layer: PeriodCostLayer): Decimal {
  const qty = new Decimal(layer.quantity);
  if (qty.lte(0)) return new Decimal(0);
  return new Decimal(layer.valueRial).div(qty);
}

/**
 * Values `countedQty` of one item against `layers` (chronological: beginning
 * inventory first, then purchases in receipt order) under `method`.
 */
export function valueEndingInventory(
  layers: PeriodCostLayer[],
  countedQty: string,
  method: PeriodicMethod,
): EndingValuation {
  const counted = new Decimal(countedQty);
  if (counted.isNegative()) throw new Error("negative_counted_qty");
  if (counted.eq(0)) return { endingValueRial: "0", excessQty: "0" };

  const positiveLayers = layers.filter((layer) => new Decimal(layer.quantity).gt(0));
  const totalQty = positiveLayers.reduce((sum, layer) => sum.plus(layer.quantity), new Decimal(0));
  const totalValue = positiveLayers.reduce((sum, layer) => sum.plus(layer.valueRial), new Decimal(0));

  if (method === "weighted_average") {
    const unit = totalQty.gt(0) ? totalValue.div(totalQty) : new Decimal(0);
    const excess = Decimal.max(counted.minus(totalQty), new Decimal(0));
    return {
      endingValueRial: counted.times(unit).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(),
      excessQty: excess.toFixed(),
    };
  }

  // FIFO ending stock = newest layers; LIFO ending stock = oldest layers.
  const walk = method === "fifo" ? [...positiveLayers].reverse() : positiveLayers;
  let remaining = counted;
  let value = new Decimal(0);
  let lastUnit = new Decimal(0);
  for (const layer of walk) {
    if (remaining.lte(0)) break;
    const layerQty = new Decimal(layer.quantity);
    const take = Decimal.min(remaining, layerQty);
    const contribution = take.eq(layerQty)
      ? new Decimal(layer.valueRial)
      : new Decimal(layer.valueRial).times(take).div(layerQty);
    value = value.plus(contribution.toDecimalPlaces(0, Decimal.ROUND_HALF_UP));
    lastUnit = layerUnitValue(layer);
    remaining = remaining.minus(take);
  }
  if (remaining.gt(0)) {
    value = value.plus(remaining.times(lastUnit).toDecimalPlaces(0, Decimal.ROUND_HALF_UP));
  }
  return {
    endingValueRial: value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(),
    excessQty: Decimal.max(remaining, new Decimal(0)).toFixed(),
  };
}

/** COGS = beginning + purchases − ending, as an integer-Rial decimal string (may be negative). */
export function periodicCogs(beginningRial: string, purchasesRial: string, endingRial: string): string {
  return (BigInt(beginningRial) + BigInt(purchasesRial) - BigInt(endingRial)).toString();
}
