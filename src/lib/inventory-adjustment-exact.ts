/**
 * Exact-decimal stock-count variance costing (costing_version 2).
 *
 * The legacy `applyStockAdjustment` in inventory-service.ts converted
 * quantities and unit costs to JavaScript Numbers and rounded per line. This
 * module keeps every quantity as canonical decimal text and every value as
 * whole-Rial bigint, so a fractional count on a high-value item costs the
 * same here as it does in the sale and purchase-receipt paths.
 *
 * DB-touching, so not unit-tested directly (repo convention) — the pure
 * helpers it leans on (inventory-exact.ts) are, and the behaviour is covered
 * by integration/exact-operational-consumption.integration.test.ts.
 */
import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import {
  allocateRialByWeight,
  minQuantity,
  positiveQuantityText,
  proportionalDepletionValue,
  quantityText,
  rialBigInt,
  rialText,
  roundRial,
  subtractQuantity,
  unitCostText,
  type QuantityText,
  type RialText,
} from "./inventory-exact";
import { consumeInventoryExact } from "./inventory-consumption-exact";
import { getCostingMethod } from "./inventory-service";

export interface ExactStockAdjustmentResult {
  /** Signed whole-Rial variance value: negative for a shortage, positive for a surplus. */
  varianceValueRial: string;
  /** Absolute unit cost used to value the movement, as canonical decimal text. */
  unitCost: string;
  /** Settlement corrections raised when a surplus closed open negative layers. */
  upwardSettlementAdjustment: RialText;
  downwardSettlementAdjustment: RialText;
}

interface NegativeLayer {
  id: string;
  remaining_quantity: string;
  remaining_provisional_value_rial: string | null;
}

function derivedUnitCost(value: RialText, quantity: QuantityText): string {
  if (new Decimal(quantity).eq(0)) return "0";
  return new Decimal(value).div(new Decimal(quantity)).toDecimalPlaces(9, Decimal.ROUND_HALF_UP).toFixed();
}

/**
 * Resolves the unit cost used to value found stock. There is no supplier
 * invoice behind a count surplus, so it is valued at the item's own current
 * cost basis: the value-weighted average of remaining FIFO lots, or the
 * carrying value per unit under weighted-average, falling back to avg_cost
 * when nothing is on hand.
 */
async function surplusUnitCost(
  client: PoolClient,
  inventoryItemId: string,
  method: string,
  avgCost: string,
  carryingValue: string | null,
  positivePhysical: Decimal,
): Promise<string> {
  const sanitize = (raw: string | null | undefined): string => {
    const num = Number(raw ?? "0");
    return !Number.isFinite(num) || num < 0
      ? "0"
      : new Decimal(raw ?? "0").toDecimalPlaces(9, Decimal.ROUND_HALF_UP).toFixed();
  };
  if (method === "fifo") {
    const { rows } = await client.query<{ quantity: string; value: string }>(
      `SELECT COALESCE(sum(remaining_qty),0)::text quantity,
              COALESCE(sum(remaining_value_rial),0)::text value
         FROM inventory_lots
        WHERE inventory_item_id=$1 AND remaining_qty>0 AND remaining_value_rial IS NOT NULL`,
      [inventoryItemId],
    );
    const quantity = new Decimal(rows[0].quantity);
    if (quantity.gt(0)) {
      return new Decimal(rows[0].value).div(quantity).toDecimalPlaces(9, Decimal.ROUND_HALF_UP).toFixed();
    }
    return unitCostText(sanitize(avgCost));
  }
  if (carryingValue !== null && positivePhysical.gt(0)) {
    return new Decimal(carryingValue).div(positivePhysical).toDecimalPlaces(9, Decimal.ROUND_HALF_UP).toFixed();
  }
  return unitCostText(sanitize(avgCost));
}

/**
 * Applies a signed stock-count variance exactly.
 *
 * A negative variance consumes stock through the same exact path as a sale,
 * so any resulting shortage becomes a *priced* negative layer. A positive
 * variance is valued at the item's current cost basis and allocated oldest
 * negative layer first; only the residual becomes positive stock. Closing a
 * layer releases its provisional value, and the difference against the
 * value actually assigned is returned for the caller to post to the ledger.
 */
export async function applyStockAdjustmentExact(
  client: PoolClient,
  params: {
    locationId: string;
    businessId: string;
    inventoryItemId: string;
    /** signed canonical decimal text: counted - system */
    delta: string;
    stockCountId: string;
    sourceType: string;
    sourceId: string | null;
    createdBy: string | null;
    inventoryEventId: string;
  },
): Promise<ExactStockAdjustmentResult> {
  const delta = new Decimal(params.delta);
  const zero = rialText("0");
  if (delta.eq(0)) {
    return {
      varianceValueRial: "0",
      unitCost: "0",
      upwardSettlementAdjustment: zero,
      downwardSettlementAdjustment: zero,
    };
  }

  if (delta.isNegative()) {
    const consumed = await consumeInventoryExact(client, {
      locationId: params.locationId,
      businessId: params.businessId,
      inventoryItemId: params.inventoryItemId,
      quantity: positiveQuantityText(delta.abs().toFixed()),
      type: "adjustment",
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      createdBy: params.createdBy,
      inventoryEventId: params.inventoryEventId,
    });
    return {
      varianceValueRial: `-${consumed.postedCost}`,
      unitCost: derivedUnitCost(consumed.postedCost, quantityText(delta.abs().toFixed())),
      upwardSettlementAdjustment: zero,
      downwardSettlementAdjustment: zero,
    };
  }

  const quantity = positiveQuantityText(delta.toFixed());
  const { rows: itemRows } = await client.query<{ avg_cost: string; carrying_value_rial: string | null }>(
    `SELECT avg_cost::text, carrying_value_rial::text
       FROM inventory_items WHERE id=$1 AND location_id=$2 FOR UPDATE`,
    [params.inventoryItemId, params.locationId],
  );
  if (!itemRows[0]) throw new Error(`inventory_item_not_found: ${params.inventoryItemId}`);

  const { rows: stockRows } = await client.query<{ quantity: string }>(
    "SELECT COALESCE(sum(quantity),0)::text quantity FROM stock_movements WHERE inventory_item_id=$1",
    [params.inventoryItemId],
  );
  const positivePhysical = Decimal.max(new Decimal(stockRows[0].quantity), new Decimal("0"));
  const method = await getCostingMethod(params.businessId, client);
  const unitCost = await surplusUnitCost(
    client,
    params.inventoryItemId,
    method,
    itemRows[0].avg_cost,
    itemRows[0].carrying_value_rial,
    positivePhysical,
  );
  const varianceValue = roundRial(new Decimal(quantity).times(new Decimal(unitCost)));

  const { rows: shortages } = await client.query<NegativeLayer>(
    `SELECT id, remaining_quantity::text, remaining_provisional_value_rial::text
       FROM inventory_negative_layers
      WHERE inventory_item_id=$1 AND remaining_quantity>0
      ORDER BY created_at,id
      FOR UPDATE`,
    [params.inventoryItemId],
  );

  let available = quantity;
  const portions: Array<{ key: string; quantity: QuantityText; layer: NegativeLayer | null }> = [];
  for (const layer of shortages) {
    if (new Decimal(available).eq(0)) break;
    if (layer.remaining_provisional_value_rial === null) {
      throw new Error(`inventory_exact_cutover_required: negative_layer:${layer.id}`);
    }
    const settled = minQuantity(available, quantityText(layer.remaining_quantity));
    portions.push({ key: `negative:${layer.id}`, quantity: settled, layer });
    available = subtractQuantity(available, settled);
  }
  if (new Decimal(available).gt(0)) {
    portions.push({ key: "positive", quantity: available, layer: null });
  }

  const allocations = allocateRialByWeight(
    varianceValue,
    portions.map((portion) => ({ key: portion.key, weight: portion.quantity })),
  );

  let upward = 0n;
  let downward = 0n;
  for (const portion of portions) {
    const actualValue = allocations.get(portion.key)!;
    if (portion.layer) {
      const remainingQuantity = quantityText(portion.layer.remaining_quantity);
      const remainingProvisional = rialText(portion.layer.remaining_provisional_value_rial!);
      const provisionalValue = proportionalDepletionValue(remainingQuantity, remainingProvisional, portion.quantity);
      const nextQuantity = subtractQuantity(remainingQuantity, portion.quantity);
      const nextValue = (rialBigInt(remainingProvisional) - rialBigInt(provisionalValue)).toString();
      await client.query(
        `UPDATE inventory_negative_layers
            SET remaining_quantity=$2,
                remaining_provisional_value_rial=$3,
                settled_at=CASE WHEN $2::numeric=0 THEN now() ELSE NULL END
          WHERE id=$1`,
        [portion.layer.id, nextQuantity, nextValue],
      );
      const difference = rialBigInt(actualValue) - rialBigInt(provisionalValue);
      if (difference > 0n) upward += difference;
      if (difference < 0n) downward += -difference;
      await client.query(
        `INSERT INTO inventory_negative_layer_settlements
           (inventory_event_id,stock_count_id,negative_layer_id,quantity,
            provisional_value_rial,actual_value_rial,difference_rial)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          params.inventoryEventId,
          params.stockCountId,
          portion.layer.id,
          portion.quantity,
          provisionalValue,
          actualValue,
          difference.toString(),
        ],
      );
    } else if (method === "fifo") {
      await client.query(
        `INSERT INTO inventory_lots
           (location_id,inventory_item_id,remaining_qty,unit_cost,source_type,source_id,inventory_event_id,
            original_quantity,original_value_rial,remaining_value_rial)
         VALUES($1,$2,$3,$4,$5,$6,$7,$3,$8,$8)`,
        [
          params.locationId,
          params.inventoryItemId,
          portion.quantity,
          derivedUnitCost(actualValue, portion.quantity),
          params.sourceType,
          params.sourceId,
          params.inventoryEventId,
          actualValue,
        ],
      );
    } else {
      const existing = itemRows[0].carrying_value_rial;
      if (existing === null && positivePhysical.gt(0)) {
        throw new Error(`inventory_exact_cutover_required: inventory_item:${params.inventoryItemId}`);
      }
      const newValue = BigInt(existing ?? "0") + rialBigInt(actualValue);
      const newQuantity = positivePhysical.plus(new Decimal(portion.quantity));
      const average = newQuantity.eq(0)
        ? "0"
        : new Decimal(newValue.toString()).div(newQuantity).toDecimalPlaces(9, Decimal.ROUND_HALF_UP).toFixed();
      await client.query("UPDATE inventory_items SET carrying_value_rial=$2,avg_cost=$3 WHERE id=$1", [
        params.inventoryItemId,
        newValue.toString(),
        average,
      ]);
    }
  }

  await client.query(
    `INSERT INTO stock_movements
       (location_id,inventory_item_id,type,quantity,unit_cost,cost_value_rial,
        source_type,source_id,created_by,inventory_event_id)
     VALUES($1,$2,'adjustment',$3,$4,$5,$6,$7,$8,$9)`,
    [
      params.locationId,
      params.inventoryItemId,
      quantity,
      derivedUnitCost(varianceValue, quantity),
      varianceValue,
      params.sourceType,
      params.sourceId,
      params.createdBy,
      params.inventoryEventId,
    ],
  );

  return {
    varianceValueRial: varianceValue,
    unitCost,
    upwardSettlementAdjustment: rialText(upward.toString()),
    downwardSettlementAdjustment: rialText(downward.toString()),
  };
}
