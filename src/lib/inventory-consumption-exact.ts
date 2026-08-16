import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import {
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
import { getCostingMethod } from "./inventory-service";

export interface ExactConsumptionResult {
  postedCost: RialText;
  shortageQuantity: QuantityText;
}

function unitCostFromValue(value: RialText, quantity: QuantityText): string {
  if (new Decimal(quantity).eq(0)) return "0";
  return new Decimal(value).div(new Decimal(quantity)).toDecimalPlaces(9, Decimal.ROUND_HALF_UP).toFixed();
}

export async function consumeInventoryExact(
  client: PoolClient,
  input: {
    locationId: string;
    businessId: string;
    inventoryItemId: string;
    quantity: QuantityText;
    type: "sale" | "waste" | "adjustment";
    sourceType: string;
    sourceId: string | null;
    note?: string | null;
    wasteReason?: string | null;
    createdBy: string | null;
    inventoryEventId: string;
    /**
     * When the movement happened, defaulting to now. A closed-order amendment
     * (order-amendment-service.ts) replays a consumption for a sale that
     * happened on an earlier day and passes that day, so the stock ledger and
     * the back-dated inventory GL account agree about which day it moved on.
     */
    occurredAt?: string | null;
  },
): Promise<ExactConsumptionResult> {
  const quantity = positiveQuantityText(input.quantity);
  const { rows: itemRows } = await client.query<{
    avg_cost: string;
    carrying_value_rial: string | null;
  }>(
    `SELECT avg_cost::text,carrying_value_rial::text
       FROM inventory_items WHERE id=$1 AND location_id=$2 FOR UPDATE`,
    [input.inventoryItemId, input.locationId],
  );
  const item = itemRows[0];
  if (!item) throw new Error(`inventory_item_not_found: ${input.inventoryItemId}`);
  const { rows: stockRows } = await client.query<{ quantity: string }>(
    "SELECT COALESCE(sum(quantity),0)::text quantity FROM stock_movements WHERE inventory_item_id=$1",
    [input.inventoryItemId],
  );
  const physical = new Decimal(stockRows[0].quantity);
  const positivePhysical = Decimal.max(physical, new Decimal("0"));
  const shortageDecimal = Decimal.max(new Decimal(quantity).minus(positivePhysical), new Decimal("0"));
  const shortageQuantity = quantityText(shortageDecimal.toFixed());
  const method = await getCostingMethod(input.businessId, client);
  let postedCost = 0n;
  let fallbackUnitCost = unitCostText(item.avg_cost);

  if (method === "fifo") {
    let needed = quantity;
    const { rows: lots } = await client.query<{
      id: string;
      remaining_qty: string;
      remaining_value_rial: string | null;
      unit_cost: string;
    }>(
      `SELECT id,remaining_qty::text,remaining_value_rial::text,unit_cost::text
         FROM inventory_lots
        WHERE inventory_item_id=$1 AND remaining_qty>0
        ORDER BY received_at,id FOR UPDATE`,
      [input.inventoryItemId],
    );
    for (const lot of lots) {
      if (new Decimal(needed).eq(0)) break;
      if (lot.remaining_value_rial === null) throw new Error(`inventory_exact_cutover_required: lot:${lot.id}`);
      const lotQuantity = quantityText(lot.remaining_qty);
      const take = quantityText(Decimal.min(new Decimal(needed), new Decimal(lotQuantity)).toFixed());
      const value = proportionalDepletionValue(lotQuantity, rialText(lot.remaining_value_rial), take);
      const nextQuantity = subtractQuantity(lotQuantity, take);
      const nextValue = (BigInt(lot.remaining_value_rial) - BigInt(value)).toString();
      await client.query(
        "UPDATE inventory_lots SET remaining_qty=$2,remaining_value_rial=$3 WHERE id=$1",
        [lot.id, nextQuantity, nextValue],
      );
      await client.query(
        `INSERT INTO stock_movements
           (location_id,inventory_item_id,type,quantity,unit_cost,cost_value_rial,
            source_type,source_id,note,waste_reason,created_by,inventory_event_id,occurred_at)
         VALUES($1,$2,$3,-$4::numeric,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13::timestamptz,now()))`,
        [
          input.locationId,
          input.inventoryItemId,
          input.type,
          take,
          unitCostFromValue(value, take),
          value,
          input.sourceType,
          input.sourceId,
          input.note ?? null,
          input.wasteReason ?? null,
          input.createdBy,
          input.inventoryEventId,
          input.occurredAt ?? null,
        ],
      );
      postedCost += rialBigInt(value);
      fallbackUnitCost = unitCostText(lot.unit_cost);
      needed = subtractQuantity(needed, take);
    }
    if (new Decimal(needed).gt(0)) {
      const shortageValue = roundRial(new Decimal(needed).times(new Decimal(fallbackUnitCost)));
      postedCost += rialBigInt(shortageValue);
      await client.query(
        `INSERT INTO stock_movements
           (location_id,inventory_item_id,type,quantity,unit_cost,cost_value_rial,
            source_type,source_id,note,waste_reason,created_by,inventory_event_id,occurred_at)
         VALUES($1,$2,$3,-$4::numeric,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13::timestamptz,now()))`,
        [
          input.locationId,
          input.inventoryItemId,
          input.type,
          needed,
          fallbackUnitCost,
          shortageValue,
          input.sourceType,
          input.sourceId,
          input.note ?? null,
          input.wasteReason ?? null,
          input.createdBy,
          input.inventoryEventId,
          input.occurredAt ?? null,
        ],
      );
    }
  } else {
    if (item.carrying_value_rial === null && positivePhysical.gt(0)) {
      throw new Error(`inventory_exact_cutover_required: inventory_item:${input.inventoryItemId}`);
    }
    const carrying = rialText(item.carrying_value_rial ?? "0");
    const positiveTaken = quantityText(Decimal.min(new Decimal(quantity), positivePhysical).toFixed());
    const positiveValue = positivePhysical.eq(0)
      ? rialText("0")
      : proportionalDepletionValue(quantityText(positivePhysical.toFixed()), carrying, positiveTaken);
    const shortfall = subtractQuantity(quantity, positiveTaken);
    const shortfallValue = roundRial(new Decimal(shortfall).times(new Decimal(fallbackUnitCost)));
    postedCost = rialBigInt(positiveValue) + rialBigInt(shortfallValue);
    const remainingValue = rialBigInt(carrying) - rialBigInt(positiveValue);
    const remainingQuantity = positivePhysical.minus(new Decimal(positiveTaken));
    const average = remainingQuantity.eq(0)
      ? "0"
      : new Decimal(remainingValue.toString())
          .div(remainingQuantity)
          .toDecimalPlaces(9, Decimal.ROUND_HALF_UP)
          .toFixed();
    await client.query(
      "UPDATE inventory_items SET carrying_value_rial=$2,avg_cost=$3 WHERE id=$1",
      [input.inventoryItemId, remainingValue.toString(), average],
    );
    await client.query(
      `INSERT INTO stock_movements
         (location_id,inventory_item_id,type,quantity,unit_cost,cost_value_rial,
          source_type,source_id,note,waste_reason,created_by,inventory_event_id,occurred_at)
       VALUES($1,$2,$3,-$4::numeric,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13::timestamptz,now()))`,
      [
        input.locationId,
        input.inventoryItemId,
        input.type,
        quantity,
        unitCostFromValue(rialText(postedCost.toString()), quantity),
        postedCost.toString(),
        input.sourceType,
        input.sourceId,
        input.note ?? null,
        input.wasteReason ?? null,
        input.createdBy,
        input.inventoryEventId,
        input.occurredAt ?? null,
      ],
    );
  }

  if (new Decimal(shortageQuantity).gt(0)) {
    const provisionalValue = roundRial(new Decimal(shortageQuantity).times(new Decimal(fallbackUnitCost)));
    await client.query(
      `INSERT INTO inventory_negative_layers
         (business_id,location_id,inventory_item_id,source_inventory_event_id,source_order_id,
          original_quantity,remaining_quantity,provisional_unit_cost,is_unpriced,
          original_provisional_value_rial,remaining_provisional_value_rial)
       VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$9)`,
      [
        input.businessId,
        input.locationId,
        input.inventoryItemId,
        input.inventoryEventId,
        input.type === "sale" ? input.sourceId : null,
        shortageQuantity,
        fallbackUnitCost,
        new Decimal(fallbackUnitCost).eq(0),
        provisionalValue,
      ],
    );
  }

  return { postedCost: rialText(postedCost.toString()), shortageQuantity };
}
