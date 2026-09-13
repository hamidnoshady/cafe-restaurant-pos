/**
 * DB-touching inventory orchestration (not unit-tested directly, per repo
 * convention — pure logic lives in inventory.ts / inventory-costing.ts and
 * is what's covered by *.test.ts).
 *
 * Everything here runs inside a caller-supplied transaction (`client`) so a
 * stock movement is always atomic with whatever triggered it (order
 * payment, a purchase receipt, a waste entry, a stock count).
 */
import type { PoolClient } from "pg";
import { query } from "./db";
import { type CostingMethod, type InventorySystem } from "./inventory-costing";
import { computeIngredientRequirements } from "./inventory";
import { getSetting, SETTING_KEYS } from "./settings";
import type { CostingSetting } from "./setup-state";
import { consumeInventoryExact } from "./inventory-consumption-exact";
import { positiveQuantityText, rialBigInt, rialText, type RialText } from "./inventory-exact";

export async function getCostingMethod(businessId: string, client?: PoolClient): Promise<CostingMethod> {
  if (client) {
    const { rows } = await client.query<{ value: CostingSetting }>(
      `SELECT value FROM settings
        WHERE business_id=$1 AND location_id IS NULL AND key=$2`,
      [businessId, SETTING_KEYS.costing],
    );
    return rows[0]?.value?.method ?? "fifo";
  }
  const costing = await getSetting<CostingSetting>(businessId, SETTING_KEYS.costing);
  return costing?.method ?? "fifo";
}

/**
 * سیستم دائمی/ادواری. Settings written before the periodic system existed
 * have no `system` field and mean "perpetual" — the only behaviour back then.
 */
export async function getInventorySystem(businessId: string, client?: PoolClient): Promise<InventorySystem> {
  if (client) {
    const { rows } = await client.query<{ value: CostingSetting }>(
      `SELECT value FROM settings
        WHERE business_id=$1 AND location_id IS NULL AND key=$2`,
      [businessId, SETTING_KEYS.costing],
    );
    return rows[0]?.value?.system ?? "perpetual";
  }
  const costing = await getSetting<CostingSetting>(businessId, SETTING_KEYS.costing);
  return costing?.system ?? "perpetual";
}

/** Current on-hand quantity for one inventory item, from the append-only stock ledger. */
export async function getCurrentStock(client: PoolClient, inventoryItemId: string): Promise<number> {
  const { rows } = await client.query<{ total: string | null }>(
    "SELECT SUM(quantity) AS total FROM stock_movements WHERE inventory_item_id = $1",
    [inventoryItemId],
  );
  return Number(rows[0]?.total ?? 0);
}

/** Current on-hand quantity for every inventory item at a location (for listing/reporting). */
export async function getStockLevels(
  locationId: string,
): Promise<Map<string, number>> {
  const { rows } = await query<{ inventory_item_id: string; total: string }>(
    `SELECT inventory_item_id, SUM(quantity) AS total
       FROM stock_movements WHERE location_id = $1 GROUP BY inventory_item_id`,
    [locationId],
  );
  return new Map(rows.map((r) => [r.inventory_item_id, Number(r.total)]));
}

export interface InventoryOverview {
  items: Record<string, unknown>[];
  suppliers: Record<string, unknown>[];
  menuItems: Record<string, unknown>[];
  modifiers: Record<string, unknown>[];
  recipes: Record<string, unknown>[];
  modifierRecipes: Record<string, unknown>[];
  costingMethod: CostingMethod;
  inventorySystem: InventorySystem;
}

/**
 * The read-only inventory shape shared by the dashboard and public API. Its
 * explicit location parameter keeps a branch-bound API key from reaching
 * stock, suppliers, or recipes belonging to another branch.
 */
export async function getInventoryOverview(
  locationId: string,
  businessId: string,
): Promise<InventoryOverview> {
  const [
    { rows: items },
    { rows: suppliers },
    { rows: menuItems },
    { rows: modifiers },
    { rows: recipes },
    { rows: modifierRecipes },
    stockLevels,
    costingMethod,
    inventorySystem,
  ] = await Promise.all([
    query(
      "SELECT id, name, sku, unit, reorder_level, avg_cost, purchase_unit, purchase_unit_factor, is_active, is_produced, image_media_id FROM inventory_items WHERE location_id = $1 ORDER BY name",
      [locationId],
    ),
    query<Record<string, unknown>>(
      /*
       * A supplier row is this branch's *alias* of a party (`suppliers.party_id` →
       * `parties`, role `Supplier`), so the identity shown here is the party's: the
       * name, the phone and the archive flag of a counterparty belong to the shared
       * record, and a branch that renamed its own copy of a supplier's name would
       * disagree with the ledger, the purchases screen and the CRM about who the
       * business pays. `s.name`/`s.phone` remain only for the pre-link rows and for
       * the branch's own note of what it called the party — the COALESCEs are that
       * fallback, not a second source of truth.
       */
      `SELECT s.id, s.name, s.phone, s.notes, s.is_active,
              s.party_id AS "partyId",
              p.name AS "partyName",
              p.phone AS "partyPhone",
              p.is_active AS "partyActive",
              COALESCE(p.name, s.name) AS "displayName",
              COALESCE(p.phone, s.phone) AS "displayPhone"
         FROM suppliers s
         LEFT JOIN parties p ON p.id = s.party_id AND p.business_id = $2
        WHERE s.location_id = $1
        ORDER BY COALESCE(p.name, s.name)`,
      [locationId, businessId],
    ),
    query("SELECT id, name FROM menu_items WHERE location_id = $1 AND is_active ORDER BY name", [locationId]),
    query(
      "SELECT m.id, m.name, m.group_id, mg.name AS group_name FROM modifiers m JOIN modifier_groups mg ON mg.id = m.group_id WHERE m.location_id = $1 AND m.is_active ORDER BY mg.name, m.name",
      [locationId],
    ),
    query(
      "SELECT mii.menu_item_id, mii.inventory_item_id, mii.quantity FROM menu_item_ingredients mii JOIN menu_items mi ON mi.id = mii.menu_item_id WHERE mi.location_id = $1",
      [locationId],
    ),
    query(
      "SELECT modi.modifier_id, modi.inventory_item_id, modi.quantity_delta FROM modifier_ingredients modi JOIN modifiers m ON m.id = modi.modifier_id WHERE m.location_id = $1",
      [locationId],
    ),
    getStockLevels(locationId),
    getCostingMethod(businessId),
    getInventorySystem(businessId),
  ]);

  const itemsWithStock = items.map((item) => ({
    ...item,
    stock: stockLevels.get(item.id as string) ?? 0,
  }));

  return {
    items: itemsWithStock,
    suppliers,
    menuItems,
    modifiers,
    recipes,
    modifierRecipes,
    costingMethod,
    inventorySystem,
  };
}

/**
 * Expands an order's non-voided items + modifiers into per-ingredient
 * requirements and deducts each one. Called once, from the payment/
 * completion transaction — order_items are frozen once an order leaves
 * 'open' (see /api/orders/[id]/pay), so this never double-deducts.
 */
export async function deductForOrder(
  client: PoolClient,
  businessId: string,
  locationId: string,
  orderId: string,
  createdBy: string | null,
  inventoryEventId: string,
  /**
   * When the sale happened, defaulting to now. A closed-order amendment
   * replays the consumption for a sale made on an earlier day and passes that
   * day, so the stock ledger agrees with the back-dated ledger entries.
   */
  occurredAt?: string | null,
): Promise<{ totalCost: RialText }> {
  // سیستم ادواری: no per-sale consumption or COGS — the sale posts revenue
  // only, and cost is recognised by the period-close document
  // (periodic-closing-service.ts). Zero cost also means postExactCogsEntry
  // drops all lines and posts nothing, so no guard is needed downstream.
  if ((await getInventorySystem(businessId, client)) === "periodic") {
    return { totalCost: rialText("0") };
  }
  const { rows: items } = await client.query<{ id: string; menu_item_id: string | null; quantity: number }>(
    "SELECT id, menu_item_id, quantity FROM order_items WHERE order_id = $1 AND status != 'voided'",
    [orderId],
  );
  if (items.length === 0) return { totalCost: rialText("0") };

  const { rows: mods } = await client.query<{ order_item_id: string; modifier_id: string | null }>(
    `SELECT oim.order_item_id, oim.modifier_id FROM order_item_modifiers oim
       JOIN order_items oi ON oi.id = oim.order_item_id
      WHERE oi.order_id = $1`,
    [orderId],
  );
  const modifiersByItem = new Map<string, string[]>();
  for (const m of mods) {
    if (!m.modifier_id) continue;
    const list = modifiersByItem.get(m.order_item_id) ?? [];
    list.push(m.modifier_id);
    modifiersByItem.set(m.order_item_id, list);
  }

  const menuItemIds = [...new Set(items.map((i) => i.menu_item_id).filter((id): id is string => Boolean(id)))];
  const modifierIds = [...new Set(mods.map((m) => m.modifier_id).filter((id): id is string => Boolean(id)))];

  const { rows: recipeRows } = menuItemIds.length
    ? await client.query<{ menu_item_id: string; inventory_item_id: string; quantity: string }>(
        "SELECT menu_item_id, inventory_item_id, quantity FROM menu_item_ingredients WHERE menu_item_id = ANY($1::uuid[])",
        [menuItemIds],
      )
    : { rows: [] };
  const recipes = new Map<string, { inventoryItemId: string; quantity: number }[]>();
  for (const r of recipeRows) {
    const list = recipes.get(r.menu_item_id) ?? [];
    list.push({ inventoryItemId: r.inventory_item_id, quantity: Number(r.quantity) });
    recipes.set(r.menu_item_id, list);
  }

  const { rows: modRecipeRows } = modifierIds.length
    ? await client.query<{ modifier_id: string; inventory_item_id: string; quantity_delta: string }>(
        "SELECT modifier_id, inventory_item_id, quantity_delta FROM modifier_ingredients WHERE modifier_id = ANY($1::uuid[])",
        [modifierIds],
      )
    : { rows: [] };
  const modifierRecipes = new Map<string, { inventoryItemId: string; quantityDelta: number }[]>();
  for (const r of modRecipeRows) {
    const list = modifierRecipes.get(r.modifier_id) ?? [];
    list.push({ inventoryItemId: r.inventory_item_id, quantityDelta: Number(r.quantity_delta) });
    modifierRecipes.set(r.modifier_id, list);
  }

  // Legacy open orders created before 0013 get one auditable fallback capture.
  for (const item of items) {
    const { rows: existing } = await client.query("SELECT 1 FROM order_item_inventory_snapshots WHERE order_item_id=$1 LIMIT 1", [item.id]);
    if (existing.length || !item.menu_item_id) continue;
    const line = computeIngredientRequirements([{
      menuItemId: item.menu_item_id, quantity: 1, modifierIds: modifiersByItem.get(item.id) ?? [],
    }], recipes, modifierRecipes);
    for (const [inventoryItemId, quantity] of line) {
      if (quantity < 0) throw new Error("negative_ingredient_requirement");
      if (quantity === 0) continue;
      await client.query(
        `INSERT INTO order_item_inventory_snapshots
         (order_item_id,inventory_item_id,required_quantity,source_menu_item_id,source_modifier_ids,capture_method,audit_metadata)
         VALUES($1,$2,$3,$4,$5,'legacy_payment_fallback',$6)`,
        [item.id,inventoryItemId,quantity,item.menu_item_id,modifiersByItem.get(item.id) ?? [],JSON.stringify({ orderId })],
      );
    }
  }
  const { rows: snapshotRows } = await client.query<{ inventory_item_id:string; required_quantity:string }>(
    `SELECT s.inventory_item_id, sum(s.required_quantity * oi.quantity)::text required_quantity
       FROM order_item_inventory_snapshots s JOIN order_items oi ON oi.id=s.order_item_id
      WHERE oi.order_id=$1 AND oi.status!='voided' GROUP BY s.inventory_item_id ORDER BY s.inventory_item_id`, [orderId]);
  const requirements = new Map(
    snapshotRows.map((r) => [r.inventory_item_id, positiveQuantityText(r.required_quantity)]),
  );

  let totalCost = 0n;
  for (const [inventoryItemId, quantity] of requirements) {
    const result = await consumeInventoryExact(client, {
      locationId,
      businessId,
      inventoryItemId,
      quantity,
      type: "sale",
      sourceType: "order",
      sourceId: orderId,
      createdBy,
      inventoryEventId,
      occurredAt,
    });
    totalCost += rialBigInt(result.postedCost);
  }
  return { totalCost: rialText(totalCost.toString()) };
}
