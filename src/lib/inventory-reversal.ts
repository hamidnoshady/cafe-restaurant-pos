/**
 * Undoing an exact (costing_version 2) inventory consumption, at the value it
 * was actually recorded at.
 *
 * Extracted from stock-count-service.ts, which had the only implementation of
 * this shape (its "shortage reversal" branch), when closed-order amendments
 * needed the same operation for a sale: a posted consumption is put back as
 * stock worth exactly what it cost when it left, first cancelling any negative
 * layer the consumption opened, so the reversal nets the ledger and the stock
 * ledger to zero rather than to today's cost basis.
 *
 * A consumption whose negative layer a later purchase or count has since
 * settled cannot be unwound bit-exactly without re-costing that settlement, so
 * it is refused (`consumption_layer_settled`) rather than silently
 * mis-accounted — the same posture reverseStockCount takes.
 *
 * DB-touching, so not unit-tested directly (repo convention); covered by
 * integration/closed-order-amendment.integration.test.ts and
 * integration/stock-count-corrections.integration.test.ts.
 */
import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import type { CostingMethod } from "./inventory-costing";

export function unitCostFromValue(value: bigint, quantity: Decimal): string {
  if (quantity.eq(0)) return "0";
  return new Decimal(value.toString())
    .div(quantity)
    .toDecimalPlaces(9, Decimal.ROUND_HALF_UP)
    .toFixed();
}

export async function insertMovement(
  client: PoolClient,
  params: {
    locationId: string;
    inventoryItemId: string;
    quantity: Decimal;
    value: bigint;
    sourceType: string;
    sourceId: string;
    createdBy: string | null;
    inventoryEventId: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO stock_movements
       (location_id, inventory_item_id, type, quantity, unit_cost, cost_value_rial,
        source_type, source_id, created_by, inventory_event_id)
     VALUES($1,$2,'adjustment',$3,$4,$5,$6,$7,$8,$9)`,
    [
      params.locationId,
      params.inventoryItemId,
      params.quantity.toFixed(),
      unitCostFromValue(params.value, params.quantity.abs()),
      params.value.toString(),
      params.sourceType,
      params.sourceId,
      params.createdBy,
      params.inventoryEventId,
    ],
  );
}

export async function adjustCarryingValue(
  client: PoolClient,
  params: { inventoryItemId: string; deltaRial: bigint },
): Promise<void> {
  const { rows } = await client.query<{ carrying: string; physical: string }>(
    `SELECT COALESCE(carrying_value_rial,0)::text carrying,
            COALESCE((SELECT sum(quantity) FROM stock_movements WHERE inventory_item_id=$1),0)::text physical
       FROM inventory_items WHERE id=$1 FOR UPDATE`,
    [params.inventoryItemId],
  );
  const carrying = BigInt(rows[0]?.carrying ?? "0");
  const physical = new Decimal(rows[0]?.physical ?? "0");
  const next = carrying + params.deltaRial;
  const average = physical.eq(0)
    ? "0"
    : new Decimal(next.toString())
        .div(physical)
        .toDecimalPlaces(9, Decimal.ROUND_HALF_UP)
        .toFixed();
  await client.query("UPDATE inventory_items SET carrying_value_rial=$2, avg_cost=$3 WHERE id=$1", [
    params.inventoryItemId,
    next.toString(),
    average,
  ]);
}

export async function insertLot(
  client: PoolClient,
  params: {
    locationId: string;
    inventoryItemId: string;
    quantity: Decimal;
    value: bigint;
    receivedAt: string;
    sourceType: string;
    sourceId: string;
    inventoryEventId: string;
  },
): Promise<void> {
  const quantity = params.quantity.toFixed();
  await client.query(
    `INSERT INTO inventory_lots
       (location_id, inventory_item_id, remaining_qty, unit_cost, source_type, source_id,
        received_at, inventory_event_id, original_quantity, original_value_rial, remaining_value_rial)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$3,$9,$9)`,
    [
      params.locationId,
      params.inventoryItemId,
      quantity,
      unitCostFromValue(params.value, params.quantity),
      params.sourceType,
      params.sourceId,
      params.receivedAt,
      params.inventoryEventId,
      params.value.toString(),
    ],
  );
}

/**
 * Cancels the negative layers one consumption event opened for one item,
 * returning what they were worth so the caller can tell how much of the
 * restored value is real stock and how much was only ever a provisional
 * shortage. A layer a later event has already drawn on is refused.
 */
async function cancelNegativeLayers(
  client: PoolClient,
  inventoryItemId: string,
  consumptionEventId: string,
): Promise<{ quantity: Decimal; value: bigint }> {
  const { rows: layers } = await client.query<{
    id: string;
    original_quantity: string;
    remaining_quantity: string;
    remaining_provisional_value_rial: string | null;
  }>(
    `SELECT id, original_quantity::text, remaining_quantity::text, remaining_provisional_value_rial::text
       FROM inventory_negative_layers
      WHERE inventory_item_id=$1 AND source_inventory_event_id=$2
      ORDER BY created_at, id
      FOR UPDATE`,
    [inventoryItemId, consumptionEventId],
  );
  let quantity = new Decimal(0);
  let value = 0n;
  for (const layer of layers) {
    if (layer.remaining_provisional_value_rial === null) {
      throw new Error(`inventory_exact_cutover_required: negative_layer:${layer.id}`);
    }
    if (new Decimal(layer.remaining_quantity).lt(new Decimal(layer.original_quantity))) {
      throw new Error("consumption_layer_settled");
    }
    const { rows: settled } = await client.query(
      "SELECT 1 FROM inventory_negative_layer_settlements WHERE negative_layer_id=$1 LIMIT 1",
      [layer.id],
    );
    if (settled.length) throw new Error("consumption_layer_settled");
    quantity = quantity.plus(layer.remaining_quantity);
    value += BigInt(layer.remaining_provisional_value_rial);
    await client.query("DELETE FROM inventory_negative_layers WHERE id=$1", [layer.id]);
  }
  return { quantity, value };
}

export interface ReversedConsumption {
  /** Whole-Rial value put back into stock — what the original consumption charged to COGS. */
  restoredValue: bigint;
  itemCount: number;
}

/**
 * Puts back every movement one consumption event made, at that event's own
 * recorded cost. `sourceType`/`sourceId` identify the *reversal* (an
 * amendment, a correction), never the original document, so the restored
 * movements and lots are attributable to the correction that created them.
 *
 * `receivedAt` positions a restored FIFO lot: pass the original document's own
 * timestamp so the stock re-enters the queue where it left it, rather than
 * behind everything bought since.
 */
export async function reverseConsumedInventory(
  client: PoolClient,
  params: {
    locationId: string;
    /** the inventory_events row whose movements are being undone */
    consumptionEventId: string;
    /** stock_movements.type of the movements to undo — 'sale' for an order, 'adjustment' for a count */
    movementType: "sale" | "waste" | "adjustment";
    sourceType: string;
    sourceId: string;
    reversalEventId: string;
    receivedAt: string;
    createdBy: string | null;
    method: CostingMethod;
  },
): Promise<ReversedConsumption> {
  const { rows: consumed } = await client.query<{
    inventory_item_id: string;
    quantity: string;
    value: string;
  }>(
    `SELECT inventory_item_id, (-sum(quantity))::text quantity, sum(cost_value_rial)::text value
       FROM stock_movements
      WHERE inventory_event_id=$1 AND type=$2
      GROUP BY inventory_item_id
     HAVING sum(quantity) < 0
      ORDER BY inventory_item_id`,
    [params.consumptionEventId, params.movementType],
  );
  if (consumed.length === 0) return { restoredValue: 0n, itemCount: 0 };

  // Same deterministic item-lock acquisition the count/purchase/sale paths use,
  // so a reversal can't deadlock against a concurrent sale or receipt.
  await client.query("SELECT id FROM inventory_items WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE", [
    consumed.map((row) => row.inventory_item_id),
  ]);

  let restoredValue = 0n;
  for (const row of consumed) {
    const quantity = new Decimal(row.quantity);
    const value = BigInt(row.value);
    restoredValue += value;

    const cancelled = await cancelNegativeLayers(client, row.inventory_item_id, params.consumptionEventId);
    await insertMovement(client, {
      locationId: params.locationId,
      inventoryItemId: row.inventory_item_id,
      quantity,
      value,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      createdBy: params.createdBy,
      inventoryEventId: params.reversalEventId,
    });

    const positiveQuantity = quantity.minus(cancelled.quantity);
    const positiveValue = value - cancelled.value;
    if (positiveQuantity.lt(0) || positiveValue < 0n) throw new Error("consumption_reversal_inconsistent");
    if (positiveQuantity.gt(0)) {
      if (params.method === "fifo") {
        await insertLot(client, {
          locationId: params.locationId,
          inventoryItemId: row.inventory_item_id,
          quantity: positiveQuantity,
          value: positiveValue,
          receivedAt: params.receivedAt,
          sourceType: params.sourceType,
          sourceId: params.sourceId,
          inventoryEventId: params.reversalEventId,
        });
      } else {
        await adjustCarryingValue(client, {
          inventoryItemId: row.inventory_item_id,
          deltaRial: positiveValue,
        });
      }
    }
  }
  return { restoredValue, itemCount: consumed.length };
}
