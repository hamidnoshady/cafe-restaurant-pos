/**
 * Phase 27 Wave 12 — recipe cost-drift (pure).
 *
 * A menu item's price was set against a recipe cost; when the ingredients'
 * running average cost rises, the priced margin erodes. This compares today's
 * material cost against the cost the item was priced at, and flags the item
 * once the rise crosses a threshold that is a *business setting* (so a
 * high-margin café can tolerate more drift than a tight-margin one), not a
 * constant buried in a query.
 */

export interface RecipeCostDriftInput {
  /** Today's material cost of the recipe (Rial). */
  currentCost: number;
  /** The recipe's material cost the menu price was set against (Rial). */
  referenceCost: number;
  /** The menu price (Rial), used for the old/new margin the report shows. */
  price: number;
  /** Flag once the cost has risen this many percent or more (business setting). */
  thresholdPercent: number;
}

export interface RecipeCostDriftResult {
  /** (current − reference) ÷ reference, as a percent. Infinity when the reference was zero and the current cost is not. */
  costChangePercent: number;
  drifted: boolean;
  /** The margin the price implied at the reference cost (percent). */
  oldMarginPercent: number;
  /** The margin the price implies at today's cost (percent). */
  newMarginPercent: number;
}

export function recipeCostDrift(input: RecipeCostDriftInput): RecipeCostDriftResult {
  const { currentCost, referenceCost, price } = input;
  const costChangePercent =
    referenceCost > 0
      ? ((currentCost - referenceCost) / referenceCost) * 100
      : currentCost > 0
        ? Number.POSITIVE_INFINITY
        : 0;
  const margin = (cost: number): number => (price > 0 ? ((price - cost) / price) * 100 : 0);
  return {
    costChangePercent,
    drifted: costChangePercent >= input.thresholdPercent,
    oldMarginPercent: margin(referenceCost),
    newMarginPercent: margin(currentCost),
  };
}
