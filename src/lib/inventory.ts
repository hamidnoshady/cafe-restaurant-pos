/**
 * Inventory domain helpers — pure functions, no DB. Quantities are in each
 * inventory item's own base unit (see migrations/0006_inventory.sql); the
 * DB-touching orchestration in inventory-service.ts resolves recipes/units
 * from the database and calls these.
 */

export interface RecipeLine {
  inventoryItemId: string;
  /** per one unit of the menu item, in the inventory item's base unit */
  quantity: number;
}

export interface ModifierRecipeLine {
  inventoryItemId: string;
  /** signed: negative removes (a swapped-out ingredient), positive adds */
  quantityDelta: number;
}

export interface OrderLineForDeduction {
  menuItemId: string | null;
  quantity: number;
  modifierIds: string[];
}

/**
 * Expands a set of (already-quantity-multiplied) order lines into total
 * inventory quantity required per inventory item, combining each line's
 * menu-item recipe with any of its modifiers' recipe deltas. Lines with no
 * menu item (deleted since sale) or no recipe contribute nothing — deletion
 * of a menu item must not block completing an order that already sold it.
 * A combined requirement that nets to zero or negative (e.g. a modifier
 * fully offsets the base recipe) is dropped rather than deducting/crediting
 * stock.
 */
export function computeIngredientRequirements(
  lines: OrderLineForDeduction[],
  recipes: Map<string, RecipeLine[]>,
  modifierRecipes: Map<string, ModifierRecipeLine[]>,
): Map<string, number> {
  const totals = new Map<string, number>();
  const add = (inventoryItemId: string, quantity: number) => {
    totals.set(inventoryItemId, (totals.get(inventoryItemId) ?? 0) + quantity);
  };

  for (const line of lines) {
    if (line.quantity <= 0) continue;
    const recipe = line.menuItemId ? (recipes.get(line.menuItemId) ?? []) : [];
    for (const r of recipe) add(r.inventoryItemId, r.quantity * line.quantity);

    for (const modifierId of line.modifierIds) {
      const modRecipe = modifierRecipes.get(modifierId) ?? [];
      for (const m of modRecipe) add(m.inventoryItemId, m.quantityDelta * line.quantity);
    }
  }

  for (const [inventoryItemId, quantity] of totals) {
    if (quantity <= 0) totals.delete(inventoryItemId);
  }
  return totals;
}

/** Purchase-unit quantity (e.g. 5 kg) -> the item's base/recipe unit quantity (e.g. 5000 g). */
export function convertPurchaseQuantity(purchaseQty: number, purchaseUnitFactor: number): number {
  return purchaseQty * purchaseUnitFactor;
}

/** True once current stock has dropped to or below the reorder threshold. Unset threshold = never. */
export function isLowStock(currentQty: number, reorderLevel: number | null): boolean {
  if (reorderLevel === null || reorderLevel === undefined) return false;
  return currentQty <= reorderLevel;
}

/** Did a deduction/waste movement newly cross the reorder threshold (wasn't low before, is now)? */
export function crossedLowStockThreshold(
  qtyBefore: number,
  qtyAfter: number,
  reorderLevel: number | null,
): boolean {
  if (reorderLevel === null || reorderLevel === undefined) return false;
  return qtyBefore > reorderLevel && qtyAfter <= reorderLevel;
}
