/**
 * سیستم ادواری — the period-close document (DB-touching orchestration; the
 * pure valuation lives in periodic-valuation.ts and is what's unit-tested,
 * per repo convention).
 *
 * A periodic business runs no per-movement costing: purchases debit «خرید
 * طی دوره» (5105), sales post revenue only. This service is the moment cost
 * is recognised — the user counts ending stock, each item is valued under
 * the locked method (میانگین موزون کلاسیک / FIFO / LIFO ادواری) against the
 * period's cost layers (beginning value + this period's received
 * purchases), and one closing entry posts
 * COGS = اول دوره + خرید − پایان دوره, restates 1300 to the counted value
 * and closes 5105 to zero. The document is immutable once posted (like a
 * stock count); a mistake is corrected by the next period's count, which
 * starts from this one's ending values.
 *
 * Everything runs inside a caller-supplied transaction (`client`).
 */
import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import { positiveQuantityText, quantityText, rialText } from "./inventory-exact";
import { postPeriodicClosingEntry } from "./ledger-service";
import { getCostingMethod, getInventorySystem } from "./inventory-service";
import { valueEndingInventory, type PeriodCostLayer, type PeriodicMethod } from "./periodic-valuation";

export interface PeriodicClosingLineInput {
  inventoryItemId: string;
  /** accepted as text so a caller can send more precision than a double carries */
  countedQty: number | string;
}

export interface PeriodicClosingResult {
  id: string;
  beginningValueRial: string;
  purchasesValueRial: string;
  endingValueRial: string;
  cogsValueRial: string;
}

export async function createPeriodicClosing(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    /** ISO date (YYYY-MM-DD), inclusive end of the period being closed */
    periodEnd: string;
    note?: string | null;
    lines: PeriodicClosingLineInput[];
    createdBy: string | null;
  },
): Promise<PeriodicClosingResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(params.periodEnd)) throw new Error("invalid_period_end");
  if (params.lines.length === 0) throw new Error("no_items");

  const system = await getInventorySystem(params.businessId, client);
  if (system !== "periodic") throw new Error("not_periodic_system");
  const method = (await getCostingMethod(params.businessId, client)) as PeriodicMethod;

  const countedByItem = new Map<string, string>();
  for (const line of params.lines) {
    if (!line.inventoryItemId) throw new Error("invalid_item");
    try {
      const qty = quantityText(String(line.countedQty ?? ""));
      if (new Decimal(qty).isNegative()) throw new Error("invalid_item");
      countedByItem.set(line.inventoryItemId, qty);
    } catch {
      throw new Error("invalid_item");
    }
  }
  const itemIds = [...countedByItem.keys()];
  const { rows: owned } = await client.query(
    "SELECT id FROM inventory_items WHERE id = ANY($1::uuid[]) AND location_id = $2",
    [itemIds, params.locationId],
  );
  if (owned.length !== new Set(itemIds).size) throw new Error("item_not_found");

  // Previous closing = start of this period. Its ending values are this
  // period's beginning layer; purchases received after it (through
  // period_end) are the further layers.
  const { rows: previousRows } = await client.query<{ id: string; period_end: string; ending_value_rial: string }>(
    `SELECT id, period_end::text, ending_value_rial::text
       FROM periodic_closings
      WHERE location_id = $1
      ORDER BY period_end DESC
      LIMIT 1
      FOR UPDATE`,
    [params.locationId],
  );
  const previous = previousRows[0] ?? null;
  if (previous && previous.period_end >= params.periodEnd) throw new Error("period_end_not_after_previous");

  // Beginning value: the previous closing's total; zero for the first close
  // (a business that opened with stock enters it as its first count — the
  // resulting negative COGS leg is the honest picture of a books-only start,
  // and the setup wizard's opening inventory is a perpetual-only feature).
  const beginningTotal = BigInt(previous?.ending_value_rial ?? "0");

  // Per-item beginning layers from the previous closing's lines.
  const beginningByItem = new Map<string, { quantity: string; valueRial: string }>();
  if (previous) {
    const { rows: previousLines } = await client.query<{
      inventory_item_id: string;
      counted_qty: string;
      ending_value_rial: string;
    }>(
      "SELECT inventory_item_id, counted_qty::text, ending_value_rial::text FROM periodic_closing_lines WHERE closing_id = $1",
      [previous.id],
    );
    for (const line of previousLines) {
      beginningByItem.set(line.inventory_item_id, {
        quantity: line.counted_qty,
        valueRial: line.ending_value_rial,
      });
    }
  }

  // This period's received purchases, per item, in receipt order. The window
  // is (previous period_end, this period_end] by purchase_date — the same
  // business-day date the purchase posting used.
  const { rows: purchaseRows } = await client.query<{
    inventory_item_id: string;
    quantity: string;
    extended_cost: string;
    purchase_date: string;
    received_at: string | null;
  }>(
    `SELECT pi.inventory_item_id, pi.quantity::text, pi.extended_cost::text,
            p.purchase_date::text, p.received_at::text
       FROM purchase_items pi
       JOIN purchases p ON p.id = pi.purchase_id
      WHERE p.location_id = $1 AND p.status = 'received'
        AND p.purchase_date <= $2::date
        AND ($3::date IS NULL OR p.purchase_date > $3::date)
      ORDER BY p.purchase_date, p.received_at NULLS FIRST, pi.id`,
    [params.locationId, params.periodEnd, previous?.period_end ?? null],
  );
  let purchasesTotal = 0n;
  const purchaseLayersByItem = new Map<string, PeriodCostLayer[]>();
  for (const row of purchaseRows) {
    purchasesTotal += BigInt(row.extended_cost);
    const layers = purchaseLayersByItem.get(row.inventory_item_id) ?? [];
    layers.push({ quantity: row.quantity, valueRial: row.extended_cost });
    purchaseLayersByItem.set(row.inventory_item_id, layers);
  }

  // Value each counted item. Items with layers but no count line are treated
  // as counted zero — their whole value flows into COGS, which is exactly
  // what "we had it, it isn't on the shelf" means at a period close. To make
  // that explicit rather than silent, every item that has a beginning layer
  // or a purchase this period must appear in the count.
  const itemsWithLayers = new Set<string>([...beginningByItem.keys(), ...purchaseLayersByItem.keys()]);
  for (const id of itemsWithLayers) {
    if (!countedByItem.has(id)) throw new Error(`count_line_missing: ${id}`);
  }

  let endingTotal = 0n;
  const valuedLines: Array<{ inventoryItemId: string; countedQty: string; endingValueRial: string }> = [];
  for (const [inventoryItemId, countedQty] of countedByItem) {
    const layers: PeriodCostLayer[] = [];
    const beginning = beginningByItem.get(inventoryItemId);
    if (beginning) layers.push(beginning);
    layers.push(...(purchaseLayersByItem.get(inventoryItemId) ?? []));
    const { endingValueRial } = valueEndingInventory(layers, countedQty, method);
    endingTotal += BigInt(endingValueRial);
    valuedLines.push({ inventoryItemId, countedQty, endingValueRial });
  }

  const cogsTotal = beginningTotal + purchasesTotal - endingTotal;

  const { rows: closingRows } = await client.query<{ id: string }>(
    `INSERT INTO periodic_closings
       (business_id, location_id, period_end, method,
        beginning_value_rial, purchases_value_rial, ending_value_rial, cogs_value_rial,
        note, created_by)
     VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      params.businessId,
      params.locationId,
      params.periodEnd,
      method,
      beginningTotal.toString(),
      purchasesTotal.toString(),
      endingTotal.toString(),
      cogsTotal.toString(),
      params.note?.trim() || null,
      params.createdBy,
    ],
  );
  const closingId = closingRows[0].id;
  for (const line of valuedLines) {
    await client.query(
      `INSERT INTO periodic_closing_lines (closing_id, inventory_item_id, counted_qty, ending_value_rial)
       VALUES ($1,$2,$3,$4)`,
      [closingId, line.inventoryItemId, positiveOrZero(line.countedQty), line.endingValueRial],
    );
  }

  const entryId = await postPeriodicClosingEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    closingId,
    createdBy: params.createdBy,
    entryDate: params.periodEnd,
    beginningValue: rialText(beginningTotal.toString()),
    purchasesValue: rialText(purchasesTotal.toString()),
    endingValue: rialText(endingTotal.toString()),
  });
  if (entryId) {
    await client.query("UPDATE periodic_closings SET journal_entry_id=$2 WHERE id=$1", [closingId, entryId]);
  }

  return {
    id: closingId,
    beginningValueRial: beginningTotal.toString(),
    purchasesValueRial: purchasesTotal.toString(),
    endingValueRial: endingTotal.toString(),
    cogsValueRial: cogsTotal.toString(),
  };
}

function positiveOrZero(quantity: string): string {
  return new Decimal(quantity).gt(0) ? positiveQuantityText(quantity) : "0";
}

export interface PeriodicClosingListRow {
  id: string;
  periodEnd: string;
  method: string;
  beginningValueRial: string;
  purchasesValueRial: string;
  endingValueRial: string;
  cogsValueRial: string;
  note: string | null;
  createdAt: string;
}

export async function listPeriodicClosings(
  client: PoolClient,
  locationId: string,
  limit = 50,
): Promise<PeriodicClosingListRow[]> {
  const { rows } = await client.query<{
    id: string;
    period_end: string;
    method: string;
    beginning_value_rial: string;
    purchases_value_rial: string;
    ending_value_rial: string;
    cogs_value_rial: string;
    note: string | null;
    created_at: string;
  }>(
    `SELECT id, period_end::text, method, beginning_value_rial::text, purchases_value_rial::text,
            ending_value_rial::text, cogs_value_rial::text, note, created_at::text
       FROM periodic_closings
      WHERE location_id = $1
      ORDER BY period_end DESC
      LIMIT $2`,
    [locationId, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    periodEnd: row.period_end,
    method: row.method,
    beginningValueRial: row.beginning_value_rial,
    purchasesValueRial: row.purchases_value_rial,
    endingValueRial: row.ending_value_rial,
    cogsValueRial: row.cogs_value_rial,
    note: row.note,
    createdAt: row.created_at,
  }));
}
