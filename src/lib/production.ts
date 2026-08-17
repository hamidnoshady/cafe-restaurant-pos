/**
 * In-house production domain helpers (Phase 29) — pure functions, no DB.
 *
 * A café makes some of what it sells. A whole cake is built from raw materials
 * once and yields 8 slices; each slice is then sold through its own serving
 * recipe (one slice + chocolate sauce). The serving recipe
 * (`menu_item_ingredients`) already existed and does not change — what was
 * missing was the step before it, which turns flour, eggs and sugar into a
 * priced stock of slices.
 *
 * The produced good is an ordinary `inventory_items` row (flagged
 * `is_produced`), so everything downstream — FIFO/weighted-average costing,
 * stock counts, waste, low-stock alerts, suggested pricing, cost drift — keeps
 * working untouched. See migrations/0090_production_runs.sql.
 *
 * Quantities here are canonical decimal text in each item's own base unit and
 * money is whole-Rial text, exactly as `inventory-exact.ts` defines them; the
 * DB-touching orchestration in production-service.ts resolves formulas from the
 * database and calls these.
 */
import Decimal from "decimal.js";
import {
  positiveQuantityText,
  quantityText,
  rialBigInt,
  rialText,
  roundRial,
  type QuantityText,
  type RialText,
} from "./inventory-exact";

export interface FormulaInput {
  inventoryItemId: string;
  /** per ONE batch of the formula, in the input item's base unit */
  quantity: QuantityText;
}

export interface ScaledInput {
  inventoryItemId: string;
  /** the formula's per-batch quantity × the number of batches run */
  quantity: QuantityText;
}

/**
 * Expands a formula's per-batch inputs into what a run of `batches` batches
 * actually consumes.
 *
 * Returned in ascending inventory-item order, which is not cosmetic: the
 * service acquires its row locks in that order, and every other exact-costing
 * path in the app (purchase receipt, sale, count, reversal) does the same, so a
 * production run cannot deadlock against a concurrent sale or receipt.
 */
export function scaleFormulaInputs(inputs: FormulaInput[], batches: QuantityText): ScaledInput[] {
  const multiplier = new Decimal(positiveQuantityText(batches));
  const totals = new Map<string, Decimal>();
  for (const input of inputs) {
    const scaled = new Decimal(positiveQuantityText(input.quantity)).times(multiplier);
    totals.set(input.inventoryItemId, (totals.get(input.inventoryItemId) ?? new Decimal(0)).plus(scaled));
  }
  return [...totals]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([inventoryItemId, quantity]) => ({
      inventoryItemId,
      // Both factors carry up to 9 decimals, so their product can carry 18 —
      // more than `quantityText` (or numeric(24,9)) accepts. Round here rather
      // than letting a formula with fine-grained quantities fail to scale.
      quantity: quantityText(quantity.toDecimalPlaces(9, Decimal.ROUND_HALF_UP).toFixed()),
    }));
}

/**
 * The yield a run of `batches` batches is expected to produce. Rounded to nine
 * decimals for the same reason `scaleFormulaInputs` is.
 */
export function scaleOutputQuantity(perBatchQuantity: QuantityText, batches: QuantityText): QuantityText {
  return quantityText(
    new Decimal(positiveQuantityText(perBatchQuantity))
      .times(new Decimal(positiveQuantityText(batches)))
      .toDecimalPlaces(9, Decimal.ROUND_HALF_UP)
      .toFixed(),
  );
}

/**
 * What one unit of the output cost, as canonical decimal text.
 *
 * Deliberately spread over the *actual* yield rather than the formula's
 * expected one: a tray that came out as 15 slices instead of 16 cost the same
 * to make, so each slice cost more, and the shelf price should be able to see
 * that. Carried at 9 decimal places, matching `inventory_items.avg_cost`, so
 * the per-unit figure never silently loses the remainder of a division that
 * does not terminate.
 */
export function productionUnitCost(totalCost: RialText, outputQuantity: QuantityText): string {
  const quantity = new Decimal(positiveQuantityText(outputQuantity));
  return new Decimal(rialText(totalCost)).div(quantity).toDecimalPlaces(9, Decimal.ROUND_HALF_UP).toFixed();
}

/**
 * Material cost + conversion cost. Both are whole Rial and so is the sum —
 * this is what the output is receipted into stock at, and what
 * `production_runs.total_cost_rial`'s CHECK constraint asserts.
 */
export function totalProductionCost(materialCost: RialText, conversionCost: RialText): RialText {
  return rialText((rialBigInt(materialCost) + rialBigInt(conversionCost)).toString());
}

/**
 * The conversion cost for a whole run, from the formula's per-batch default.
 *
 * A run may override it outright (the service takes the override when one is
 * given); this is what the UI prefills and what an API caller that omits it
 * gets. Rounded to whole Rial like every other money value in the app.
 */
export function scaleConversionCost(perBatchCost: RialText, batches: QuantityText): RialText {
  return roundRial(new Decimal(rialText(perBatchCost)).times(new Decimal(positiveQuantityText(batches))));
}

export interface YieldVariance {
  expected: QuantityText;
  actual: QuantityText;
  /** actual − expected, signed: negative means the batch fell short. */
  difference: string;
  /** (actual − expected) ÷ expected × 100, signed and rounded to one decimal. */
  percent: number;
}

/**
 * How far a batch landed from what the formula promised.
 *
 * Reported rather than enforced: a short yield is normal (a cake breaks, a
 * syrup reduces further than expected) and its cost consequence is already
 * carried by `productionUnitCost` spreading over the actual figure. This is
 * only what the run list shows the owner so a formula that is persistently
 * optimistic becomes visible.
 */
export function yieldVariance(expectedQuantity: QuantityText, actualQuantity: QuantityText): YieldVariance {
  const expected = new Decimal(positiveQuantityText(expectedQuantity));
  const actual = new Decimal(positiveQuantityText(actualQuantity));
  const difference = actual.minus(expected);
  return {
    expected: quantityText(expected.toFixed()),
    actual: quantityText(actual.toFixed()),
    difference: difference.toFixed(),
    percent: Number(difference.div(expected).times(100).toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toFixed()),
  };
}

/**
 * What one batch of a formula would cost in materials at today's running
 * average costs — the estimate the formula editor shows before any batch has
 * ever been run.
 *
 * This is an *estimate only*. A real run is costed by the exact FIFO/
 * weighted-average consumption path, never by this, so the two can legitimately
 * differ; an item with no `avg_cost` yet (nothing bought) contributes zero
 * rather than making the whole estimate unavailable.
 */
export function expectedMaterialCost(inputs: FormulaInput[], avgCostByItem: Map<string, string>): RialText {
  let total = new Decimal(0);
  for (const input of inputs) {
    const avgCost = avgCostByItem.get(input.inventoryItemId);
    if (!avgCost) continue;
    total = total.plus(new Decimal(positiveQuantityText(input.quantity)).times(new Decimal(avgCost)));
  }
  return roundRial(total);
}

/**
 * Would making `outputItemId` out of `inputItemIds` create a loop?
 *
 * A formula's input may itself be produced — a sponge base becomes a cake
 * becomes a slice — and that nesting is deliberate. What must not exist is a
 * cycle: if the cake is made from the sponge, the sponge must not be made from
 * the cake, or costing a run would never terminate.
 *
 * `producedBy` maps each produced item to the inputs of the formula that makes
 * it. The walk starts at the proposed inputs and follows their own formulas
 * upward, so it catches indirect cycles as well as the trivial "an item is its
 * own ingredient" one.
 */
export function formulaWouldCycle(
  outputItemId: string,
  inputItemIds: string[],
  producedBy: Map<string, string[]>,
): boolean {
  const seen = new Set<string>();
  const queue = [...inputItemIds];
  while (queue.length > 0) {
    const itemId = queue.shift()!;
    if (itemId === outputItemId) return true;
    if (seen.has(itemId)) continue;
    seen.add(itemId);
    queue.push(...(producedBy.get(itemId) ?? []));
  }
  return false;
}
