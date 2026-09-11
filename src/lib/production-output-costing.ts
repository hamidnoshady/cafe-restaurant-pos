/**
 * Receipting a production run's output into stock, exactly (costing_version 2).
 *
 * This is the positive branch of `applyStockAdjustmentExact`
 * (inventory-adjustment-exact.ts) with one deliberate difference: the value is
 * *given* rather than derived from the item's current cost basis. A count
 * surplus has no document behind it, so it is valued at what the item is
 * already carried at; a production run does have one — the exact cost of the
 * materials it consumed plus the conversion cost it absorbed — and that is
 * authoritative, the same posture `applyPurchaseReceiptCosting` takes towards
 * a supplier invoice.
 *
 * The negative-layer handling is not optional decoration. A café sells slices
 * from a cake that is still in the oven often enough that the produced item
 * routinely carries open shortages by the time a run lands; the run settles
 * them oldest-first at their real cost, and only the residual becomes positive
 * stock. Without that, the run would create stock the till had already sold.
 *
 * DB-touching, so not unit-tested directly (repo convention) — the pure
 * helpers it leans on (inventory-exact.ts, production.ts) are, and the
 * behaviour is covered by integration/production-runs.integration.test.ts.
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
  subtractQuantity,
  type QuantityText,
  type RialText,
} from "./inventory-exact";
import { isLotBased } from "./inventory-costing";
import { getCostingMethod } from "./inventory-service";

export interface ProductionOutputResult {
  /** Correction raised where a settled shortage turned out to have been under-provisioned. */
  upwardSettlementAdjustment: RialText;
  /** …and where it had been over-provisioned. */
  downwardSettlementAdjustment: RialText;
  /** How much of the output went to closing shortages rather than to the shelf. */
  settledQuantity: QuantityText;
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

export async function applyProductionOutputCosting(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    inventoryItemId: string;
    /** actual yield, in the output item's base unit */
    quantity: QuantityText;
    /** material cost + conversion cost — what the batch is worth */
    totalValue: RialText;
    productionRunId: string;
    inventoryEventId: string;
    createdBy: string | null;
    /** when the batch was made, defaulting to now — a reversal replays the original document's date */
    occurredAt?: string | null;
  },
): Promise<ProductionOutputResult> {
  const quantity = positiveQuantityText(params.quantity);
  const totalValue = rialText(params.totalValue);

  const { rows: itemRows } = await client.query<{ carrying_value_rial: string | null }>(
    `SELECT carrying_value_rial::text
       FROM inventory_items WHERE id=$1 AND location_id=$2 FOR UPDATE`,
    [params.inventoryItemId, params.locationId],
  );
  if (!itemRows[0]) throw new Error(`inventory_item_not_found: ${params.inventoryItemId}`);

  const { rows: stockRows } = await client.query<{ quantity: string }>(
    "SELECT COALESCE(sum(quantity),0)::text quantity FROM stock_movements WHERE inventory_item_id=$1",
    [params.inventoryItemId],
  );
  const priorPhysical = new Decimal(stockRows[0].quantity);
  const method = await getCostingMethod(params.businessId, client);

  const { rows: shortages } = await client.query<NegativeLayer>(
    `SELECT id, remaining_quantity::text, remaining_provisional_value_rial::text
       FROM inventory_negative_layers
      WHERE inventory_item_id=$1 AND remaining_quantity>0
      ORDER BY created_at,id
      FOR UPDATE`,
    [params.inventoryItemId],
  );

  let available = quantity;
  let settledQuantity = quantityText("0");
  const portions: Array<{ key: string; quantity: QuantityText; layer: NegativeLayer | null; sequence: number }> = [];
  for (const layer of shortages) {
    if (new Decimal(available).eq(0)) break;
    if (layer.remaining_provisional_value_rial === null) {
      throw new Error(`inventory_exact_cutover_required: negative_layer:${layer.id}`);
    }
    const settled = minQuantity(available, quantityText(layer.remaining_quantity));
    portions.push({ key: `negative:${layer.id}`, quantity: settled, layer, sequence: portions.length });
    available = subtractQuantity(available, settled);
    settledQuantity = quantityText(new Decimal(settledQuantity).plus(new Decimal(settled)).toFixed());
  }
  if (new Decimal(available).gt(0)) {
    portions.push({ key: "positive", quantity: available, layer: null, sequence: portions.length });
  }

  const allocations = allocateRialByWeight(
    totalValue,
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
           (inventory_event_id,production_run_id,negative_layer_id,quantity,
            provisional_value_rial,actual_value_rial,difference_rial)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          params.inventoryEventId,
          params.productionRunId,
          portion.layer.id,
          portion.quantity,
          provisionalValue,
          actualValue,
          difference.toString(),
        ],
      );
    } else if (isLotBased(method)) {
      await client.query(
        `INSERT INTO inventory_lots
           (location_id,inventory_item_id,remaining_qty,unit_cost,source_type,source_id,received_at,inventory_event_id,
            original_quantity,original_value_rial,remaining_value_rial)
         VALUES($1,$2,$3,$4,'production',$5,COALESCE($6::timestamptz,now()),$7,$3,$8,$8)`,
        [
          params.locationId,
          params.inventoryItemId,
          portion.quantity,
          derivedUnitCost(actualValue, portion.quantity),
          params.productionRunId,
          params.occurredAt ?? null,
          params.inventoryEventId,
          actualValue,
        ],
      );
    } else {
      const existing = itemRows[0].carrying_value_rial;
      if (existing === null && priorPhysical.gt(0)) {
        throw new Error(`inventory_exact_cutover_required: inventory_item:${params.inventoryItemId}`);
      }
      const newValue = BigInt(existing ?? "0") + rialBigInt(actualValue);
      const positiveQuantity = Decimal.max(priorPhysical, new Decimal("0")).plus(new Decimal(portion.quantity));
      const average = positiveQuantity.eq(0)
        ? "0"
        : new Decimal(newValue.toString()).div(positiveQuantity).toDecimalPlaces(9, Decimal.ROUND_HALF_UP).toFixed();
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
        source_type,source_id,created_by,inventory_event_id,occurred_at)
     VALUES($1,$2,'production_output',$3,$4,$5,'production',$6,$7,$8,COALESCE($9::timestamptz,now()))`,
    [
      params.locationId,
      params.inventoryItemId,
      quantity,
      derivedUnitCost(totalValue, quantity),
      totalValue,
      params.productionRunId,
      params.createdBy,
      params.inventoryEventId,
      params.occurredAt ?? null,
    ],
  );

  return {
    upwardSettlementAdjustment: rialText(upward.toString()),
    downwardSettlementAdjustment: rialText(downward.toString()),
    settledQuantity,
  };
}
