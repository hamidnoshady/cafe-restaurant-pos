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
import {
  calculateNewAverageCost,
  getCostingStrategy,
  type CostingMethod,
  type Lot,
} from "./inventory-costing";
import { computeIngredientRequirements, crossedLowStockThreshold, type OrderLineForDeduction } from "./inventory";
import { broadcast } from "./realtime";
import { getSetting, SETTING_KEYS } from "./settings";
import type { CostingSetting } from "./setup-state";
import type { Rial } from "./money";

export async function getCostingMethod(businessId: string): Promise<CostingMethod> {
  const costing = await getSetting<CostingSetting>(businessId, SETTING_KEYS.costing);
  return costing?.method ?? "fifo";
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

interface InventoryItemRow {
  id: string;
  name: string;
  unit: string;
  avg_cost: string;
  reorder_level: string | null;
}

async function lockInventoryItem(client: PoolClient, inventoryItemId: string): Promise<InventoryItemRow> {
  const { rows } = await client.query<InventoryItemRow>(
    "SELECT id, name, unit, avg_cost, reorder_level FROM inventory_items WHERE id = $1 FOR UPDATE",
    [inventoryItemId],
  );
  const item = rows[0];
  if (!item) throw new Error(`inventory_item_not_found: ${inventoryItemId}`);
  return item;
}

export interface ConsumeInventoryInput {
  locationId: string;
  businessId: string;
  inventoryItemId: string;
  quantity: number; // positive; the amount to remove from stock
  type: "sale" | "waste" | "adjustment";
  sourceType: string;
  sourceId: string | null;
  note?: string | null;
  wasteReason?: string | null;
  createdBy: string | null;
  inventoryEventId?: string | null;
}

export interface ConsumeInventoryResult {
  totalCost: Rial;
  shortfall: number;
}

/**
 * Deducts `quantity` of one inventory item, costed by the business's locked
 * costing method, and writes the resulting stock_movement row(s). Shared by
 * order-completion deduction (type 'sale') and manual waste logging (type
 * 'waste') — the only difference is the movement type/source/reason.
 */
export async function consumeInventory(
  client: PoolClient,
  input: ConsumeInventoryInput,
): Promise<ConsumeInventoryResult> {
  if (input.quantity <= 0) return { totalCost: 0, shortfall: 0 };

  const item = await lockInventoryItem(client, input.inventoryItemId);
  const method = await getCostingMethod(input.businessId);
  const currentStock = await getCurrentStock(client, input.inventoryItemId);
  const avgCost = Number(item.avg_cost);

  let lots: Lot[] = [];
  if (method === "fifo") {
    const { rows } = await client.query<{ id: string; remaining_qty: string; unit_cost: string }>(
      `SELECT id, remaining_qty, unit_cost FROM inventory_lots
        WHERE inventory_item_id = $1 AND remaining_qty > 0
        ORDER BY received_at ASC FOR UPDATE`,
      [input.inventoryItemId],
    );
    lots = rows.map((r) => ({ id: r.id, remainingQty: Number(r.remaining_qty), unitCost: Number(r.unit_cost) }));
  }

  const strategy = getCostingStrategy(method);
  const result = strategy.calculateCOGS(lots, input.quantity, avgCost);

  for (const line of result.lines) {
    if (line.lotId) {
      await client.query(
        "UPDATE inventory_lots SET remaining_qty = remaining_qty - $2 WHERE id = $1",
        [line.lotId, line.quantity],
      );
    }
    await client.query(
      `INSERT INTO stock_movements
         (location_id, inventory_item_id, type, quantity, unit_cost, source_type, source_id, note, waste_reason, created_by, inventory_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        input.locationId,
        input.inventoryItemId,
        input.type,
        -line.quantity,
        line.unitCost,
        input.sourceType,
        input.sourceId,
        input.note ?? null,
        input.wasteReason ?? null,
        input.createdBy,
        input.inventoryEventId ?? null,
      ],
    );
  }

  const newStock = currentStock - input.quantity;
  const reorderLevel = item.reorder_level === null ? null : Number(item.reorder_level);
  if (crossedLowStockThreshold(currentStock, newStock, reorderLevel)) {
    broadcast(input.locationId, {
      type: "inventory.low_stock",
      inventoryItemId: item.id,
      name: item.name,
      quantity: newStock,
      reorderLevel: reorderLevel as number,
    });
  }

  return { totalCost: result.totalCost, shortfall: result.shortfall };
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
): Promise<{ totalCost: Rial }> {
  const { rows: items } = await client.query<{ id: string; menu_item_id: string | null; quantity: number }>(
    "SELECT id, menu_item_id, quantity FROM order_items WHERE order_id = $1 AND status != 'voided'",
    [orderId],
  );
  if (items.length === 0) return { totalCost: 0 };

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

  const lines: OrderLineForDeduction[] = items.map((i) => ({
    menuItemId: i.menu_item_id,
    quantity: i.quantity,
    modifierIds: modifiersByItem.get(i.id) ?? [],
  }));
  const requirements = computeIngredientRequirements(lines, recipes, modifierRecipes);

  let totalCost = 0;
  for (const [inventoryItemId, quantity] of requirements) {
    const result = await consumeInventory(client, {
      locationId,
      businessId,
      inventoryItemId,
      quantity,
      type: "sale",
      sourceType: "order",
      sourceId: orderId,
      createdBy,
    });
    totalCost += result.totalCost;
  }
  return { totalCost };
}

/**
 * Applies a signed stock-count variance (counted - system): a positive
 * delta is recorded like a small purchase receipt (new lot / avg_cost roll
 * forward, valued at the item's current avg_cost since there's no supplier
 * invoice to price it from); a negative delta consumes stock the same way
 * a sale or waste entry would, so it draws down the same FIFO lots.
 */
export async function applyStockAdjustment(
  client: PoolClient,
  params: {
    locationId: string;
    businessId: string;
    inventoryItemId: string;
    delta: number;
    sourceType: string;
    sourceId: string | null;
    createdBy: string | null;
    inventoryEventId?: string | null;
  },
): Promise<Rial> {
  const { locationId, businessId, inventoryItemId, delta, sourceType, sourceId, createdBy } = params;
  if (delta === 0) return 0;

  if (delta < 0) {
    const result = await consumeInventory(client, {
      locationId,
      businessId,
      inventoryItemId,
      quantity: -delta,
      type: "adjustment",
      sourceType,
      sourceId,
      createdBy,
      inventoryEventId: params.inventoryEventId,
    });
    return -result.totalCost;
  }

  const item = await lockInventoryItem(client, inventoryItemId);
  const currentStock = await getCurrentStock(client, inventoryItemId);
  const method = await getCostingMethod(businessId);
  let unitCost = Number(item.avg_cost);
  if (method === "fifo") {
    const { rows } = await client.query<{ cost: string }>(
      `SELECT COALESCE(sum(remaining_qty * unit_cost) / NULLIF(sum(remaining_qty),0),0) cost
         FROM inventory_lots WHERE inventory_item_id=$1 AND remaining_qty>0`, [inventoryItemId]);
    unitCost = Number(rows[0].cost);
  }

  await client.query(
    `INSERT INTO stock_movements
       (location_id, inventory_item_id, type, quantity, unit_cost, source_type, source_id, created_by, inventory_event_id)
     VALUES ($1, $2, 'adjustment', $3, $4, $5, $6, $7, $8)`,
    [locationId, inventoryItemId, delta, unitCost, sourceType, sourceId, createdBy, params.inventoryEventId ?? null],
  );

  if (method === "fifo") {
    await client.query(
      `INSERT INTO inventory_lots (location_id, inventory_item_id, remaining_qty, unit_cost, source_type, source_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [locationId, inventoryItemId, delta, unitCost, sourceType, sourceId],
    );
    await client.query("UPDATE inventory_lots SET inventory_event_id=$2 WHERE source_type=$3 AND source_id=$4 AND inventory_item_id=$1 AND inventory_event_id IS NULL", [inventoryItemId, params.inventoryEventId ?? null, sourceType, sourceId]);
  } else {
    const newAvg = calculateNewAverageCost(currentStock, unitCost, delta, unitCost);
    await client.query("UPDATE inventory_items SET avg_cost = $2 WHERE id = $1", [inventoryItemId, newAvg]);
  }
  return Math.round(delta * unitCost);
}

export interface ReceivePurchaseItem {
  inventoryItemId: string;
  /** already converted to the item's base unit */
  quantity: number;
  unitCost: Rial;
}

/** Receiving a purchase increases stock and (weighted-average only) rolls the item's avg_cost forward. */
export async function receivePurchase(
  client: PoolClient,
  locationId: string,
  businessId: string,
  purchaseId: string,
  items: ReceivePurchaseItem[],
  createdBy: string | null,
  inventoryEventId?: string | null,
): Promise<void> {
  const method = await getCostingMethod(businessId);
  for (const it of [...items].sort((a, b) => a.inventoryItemId.localeCompare(b.inventoryItemId))) {
    if (it.quantity <= 0) continue;
    const item = await lockInventoryItem(client, it.inventoryItemId);
    const currentStock = await getCurrentStock(client, it.inventoryItemId);

    await client.query(
      `INSERT INTO stock_movements
         (location_id, inventory_item_id, type, quantity, unit_cost, source_type, source_id, created_by, inventory_event_id)
       VALUES ($1, $2, 'purchase', $3, $4, 'purchase', $5, $6, $7)`,
      [locationId, it.inventoryItemId, it.quantity, it.unitCost, purchaseId, createdBy, inventoryEventId ?? null],
    );

    if (method === "fifo") {
      await client.query(
        `INSERT INTO inventory_lots (location_id, inventory_item_id, remaining_qty, unit_cost, source_type, source_id, inventory_event_id)
         VALUES ($1, $2, $3, $4, 'purchase', $5, $6)`,
        [locationId, it.inventoryItemId, it.quantity, it.unitCost, purchaseId, inventoryEventId ?? null],
      );
    } else {
      const newAvg = calculateNewAverageCost(currentStock, Number(item.avg_cost), it.quantity, it.unitCost);
      await client.query("UPDATE inventory_items SET avg_cost = $2 WHERE id = $1", [it.inventoryItemId, newAvg]);
    }
  }
}
