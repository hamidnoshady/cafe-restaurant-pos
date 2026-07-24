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
import { getCostingMethod } from "./inventory-service";

export interface ExactPurchaseReceiptItem {
  purchaseItemId: string;
  inventoryItemId: string;
  quantity: QuantityText;
  extendedCost: RialText;
}

export interface PurchaseReceiptCostingResult {
  receiptValue: RialText;
  upwardSettlementAdjustment: RialText;
  downwardSettlementAdjustment: RialText;
}

interface NegativeLayer {
  id: string;
  remaining_quantity: string;
  remaining_provisional_value_rial: string | null;
}

function derivedUnitCost(value: RialText, quantity: QuantityText): string {
  return new Decimal(value).div(new Decimal(quantity)).toDecimalPlaces(9, Decimal.ROUND_HALF_UP).toFixed();
}

/**
 * Applies a version-2 purchase receipt. Receipt extended cost is authoritative:
 * it is allocated across oldest negative layers first and only the residual
 * quantity/value becomes positive stock.
 */
export async function applyPurchaseReceiptCosting(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    purchaseId: string;
    inventoryEventId: string;
    items: ExactPurchaseReceiptItem[];
    createdBy: string | null;
  },
): Promise<PurchaseReceiptCostingResult> {
  const method = await getCostingMethod(params.businessId, client);
  let receiptValue = 0n;
  let upward = 0n;
  let downward = 0n;

  for (const itemInput of [...params.items].sort((a, b) => a.inventoryItemId.localeCompare(b.inventoryItemId))) {
    const quantity = positiveQuantityText(itemInput.quantity);
    const extendedCost = rialText(itemInput.extendedCost);
    receiptValue += rialBigInt(extendedCost);

    const { rows: inventoryRows } = await client.query<{
      carrying_value_rial: string | null;
    }>(
      `SELECT carrying_value_rial::text
         FROM inventory_items
        WHERE id=$1 AND location_id=$2
        FOR UPDATE`,
      [itemInput.inventoryItemId, params.locationId],
    );
    if (!inventoryRows[0]) throw new Error(`inventory_item_not_found: ${itemInput.inventoryItemId}`);

    const { rows: stockRows } = await client.query<{ quantity: string }>(
      `SELECT COALESCE(sum(quantity),0)::text quantity
         FROM stock_movements WHERE inventory_item_id=$1`,
      [itemInput.inventoryItemId],
    );
    const priorPhysical = new Decimal(stockRows[0].quantity);
    const { rows: shortages } = await client.query<NegativeLayer>(
      `SELECT id, remaining_quantity::text, remaining_provisional_value_rial::text
         FROM inventory_negative_layers
        WHERE inventory_item_id=$1 AND remaining_quantity>0
        ORDER BY created_at,id
        FOR UPDATE`,
      [itemInput.inventoryItemId],
    );

    let available = quantity;
    const portions: Array<{
      key: string;
      quantity: QuantityText;
      layer: NegativeLayer | null;
      sequence: number;
    }> = [];
    for (const layer of shortages) {
      if (new Decimal(available).eq(0)) break;
      if (layer.remaining_provisional_value_rial === null) {
        throw new Error(`inventory_exact_cutover_required: negative_layer:${layer.id}`);
      }
      const settled = minQuantity(available, quantityText(layer.remaining_quantity));
      portions.push({ key: `negative:${layer.id}`, quantity: settled, layer, sequence: portions.length });
      available = subtractQuantity(available, settled);
    }
    if (new Decimal(available).gt(0)) {
      portions.push({ key: "positive", quantity: available, layer: null, sequence: portions.length });
    }

    const actualAllocations = allocateRialByWeight(
      extendedCost,
      portions.map((portion) => ({ key: portion.key, weight: portion.quantity })),
    );
    let positiveLotId: string | null = null;

    for (const portion of portions) {
      const actualValue = actualAllocations.get(portion.key)!;
      if (portion.layer) {
        const remainingQuantity = quantityText(portion.layer.remaining_quantity);
        const remainingProvisional = rialText(portion.layer.remaining_provisional_value_rial!);
        const provisionalValue = proportionalDepletionValue(
          remainingQuantity,
          remainingProvisional,
          portion.quantity,
        );
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
             (inventory_event_id,purchase_item_id,negative_layer_id,quantity,
              provisional_value_rial,actual_value_rial,difference_rial)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            params.inventoryEventId,
            itemInput.purchaseItemId,
            portion.layer.id,
            portion.quantity,
            provisionalValue,
            actualValue,
            difference.toString(),
          ],
        );
      } else if (method === "fifo") {
        const unitCost = derivedUnitCost(actualValue, portion.quantity);
        const { rows: lotRows } = await client.query<{ id: string }>(
          `INSERT INTO inventory_lots
             (location_id,inventory_item_id,remaining_qty,unit_cost,source_type,source_id,inventory_event_id,
              original_quantity,original_value_rial,remaining_value_rial)
           VALUES($1,$2,$3,$4,'purchase',$5,$6,$3,$7,$7)
           RETURNING id`,
          [
            params.locationId,
            itemInput.inventoryItemId,
            portion.quantity,
            unitCost,
            params.purchaseId,
            params.inventoryEventId,
            actualValue,
          ],
        );
        positiveLotId = lotRows[0].id;
      } else {
        const existingValue = inventoryRows[0].carrying_value_rial;
        if (existingValue === null && priorPhysical.gt(0)) {
          throw new Error(`inventory_exact_cutover_required: inventory_item:${itemInput.inventoryItemId}`);
        }
        const newValue = BigInt(existingValue ?? "0") + rialBigInt(actualValue);
        const positiveQuantity = Decimal.max(priorPhysical, new Decimal("0")).plus(new Decimal(portion.quantity));
        const average = new Decimal(newValue.toString())
          .div(positiveQuantity)
          .toDecimalPlaces(9, Decimal.ROUND_HALF_UP)
          .toFixed();
        await client.query(
          "UPDATE inventory_items SET carrying_value_rial=$2,avg_cost=$3 WHERE id=$1",
          [itemInput.inventoryItemId, newValue.toString(), average],
        );
      }

      await client.query(
        `INSERT INTO purchase_receipt_cost_allocations
           (inventory_event_id,purchase_item_id,inventory_item_id,allocation_kind,
            negative_layer_id,inventory_lot_id,quantity,actual_value_rial,sequence)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          params.inventoryEventId,
          itemInput.purchaseItemId,
          itemInput.inventoryItemId,
          portion.layer ? "negative_settlement" : "positive_stock",
          portion.layer?.id ?? null,
          positiveLotId,
          portion.quantity,
          actualValue,
          portion.sequence,
        ],
      );
    }

    await client.query(
      `INSERT INTO stock_movements
         (location_id,inventory_item_id,type,quantity,unit_cost,cost_value_rial,
          source_type,source_id,created_by,inventory_event_id)
       VALUES($1,$2,'purchase',$3,$4,$5,'purchase',$6,$7,$8)`,
      [
        params.locationId,
        itemInput.inventoryItemId,
        quantity,
        derivedUnitCost(extendedCost, quantity),
        extendedCost,
        params.purchaseId,
        params.createdBy,
        params.inventoryEventId,
      ],
    );
  }

  return {
    receiptValue: rialText(receiptValue.toString()),
    upwardSettlementAdjustment: rialText(upward.toString()),
    downwardSettlementAdjustment: rialText(downward.toString()),
  };
}
