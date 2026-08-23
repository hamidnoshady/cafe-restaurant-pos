/**
 * Physical stock counts (انبارگردانی) for the retail `items` model.
 *
 * The counterpart of stock-count-service.ts, and much smaller than it by
 * construction rather than by omission: `item_stock` is a moving
 * weighted-average row per item with no lots, no FIFO layers and no negative
 * layers (0068_item_stock.sql chose that deliberately), so a count here is
 * arithmetic on one row and needs none of the negative-layer settlement the
 * F&B path carries.
 *
 * Two rules do the load-bearing work:
 *
 *  - **A count sets the quantity, it does not adjust it by a delta.** The
 *    counted figure is what is physically on the shelf, so writing it directly
 *    cannot drive `item_stock.quantity` below zero and trip its CHECK — a
 *    delta computed against a stale read could.
 *  - **The unit cost never moves.** Finding one more lipstick than expected
 *    does not change what lipsticks cost; only the quantity was wrong. The
 *    variance is valued at the average already on the row, and that average is
 *    frozen onto the count line so a reversal undoes the count at the value it
 *    actually posted.
 *
 * A posted count is corrected by reversal, never edited — the same rule
 * production runs and F&B's counts follow.
 *
 * DB-touching, so not unit-tested directly (repo convention); behaviour is
 * covered by integration/item-stock-counts.integration.test.ts.
 */
import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import { rialText, type RialText } from "./inventory-exact";
import { emitDomainEvent } from "./posting-engine";
import "./retail-stock-posting-rules";

export interface ItemStockCountLineInput {
  itemId: string;
  /** Accepted as text so a caller can send more precision than a double carries. */
  countedQty: number | string;
}

export interface ItemStockCountLine {
  id: string;
  itemId: string;
  itemName: string;
  systemQty: string;
  countedQty: string;
  variance: string;
  unitCost: string | null;
  varianceValue: string;
}

export interface ItemStockCountDetail {
  id: string;
  note: string | null;
  countedAt: string;
  countedByName: string | null;
  entryId: string | null;
  reversedAt: string | null;
  lines: ItemStockCountLine[];
}

const QUANTITY_RE = /^-?\d+(\.\d+)?$/;

/** A counted quantity, normalised to the precision `item_stock.quantity` holds. */
function countedQuantityText(raw: number | string): string {
  const text = String(raw).trim();
  if (!QUANTITY_RE.test(text)) throw new Error("invalid_quantity");
  const value = new Decimal(text);
  if (value.isNegative()) throw new Error("invalid_quantity");
  return value.toFixed(9);
}

/**
 * Records a count and moves stock to match it.
 *
 * Every line is written even when its variance is zero: "we counted this and it
 * was right" is a different, and auditable, statement from "we did not count
 * this", and a count sheet that silently dropped its correct lines could not
 * show which shelves were actually visited.
 */
export async function createItemStockCount(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    note?: string | null;
    lines: ItemStockCountLineInput[];
    createdBy: string | null;
  },
): Promise<{ id: string; entryId: string | null; shortage: string; surplus: string }> {
  if (params.lines.length === 0) throw new Error("no_items");

  const countedByItem = new Map<string, string>();
  for (const line of params.lines) {
    if (!line.itemId) throw new Error("invalid_item");
    // A code scanned twice is two of the same thing, but the *caller* owns that
    // tally; two lines for one item here is a malformed request, not a sum.
    if (countedByItem.has(line.itemId)) throw new Error("duplicate_item");
    countedByItem.set(line.itemId, countedQuantityText(line.countedQty));
  }

  const itemIds = [...countedByItem.keys()];
  const { rows: owned } = await client.query<{ id: string }>(
    "SELECT id FROM items WHERE id = ANY($1::uuid[]) AND location_id = $2",
    [itemIds, params.locationId],
  );
  if (owned.length !== itemIds.length) throw new Error("item_not_found");

  // One deterministic lock acquisition, ordered by id, so a count cannot
  // deadlock against a concurrent sale, receipt or transfer — the same
  // discipline createStockCount uses on the F&B side.
  await client.query("SELECT id FROM items WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE", [itemIds]);

  const { rows: countRows } = await client.query<{ id: string }>(
    `INSERT INTO item_stock_counts (business_id, location_id, note, counted_by)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [params.businessId, params.locationId, params.note?.trim() || null, params.createdBy],
  );
  const countId = countRows[0].id;

  let shortage = new Decimal(0);
  let surplus = new Decimal(0);

  for (const itemId of [...countedByItem.keys()].sort()) {
    const countedQty = countedByItem.get(itemId)!;
    const { rows: stockRows } = await client.query<{ quantity: string; unit_cost: string | null }>(
      "SELECT quantity::text, unit_cost::text FROM item_stock WHERE item_id = $1 FOR UPDATE",
      [itemId],
    );
    const systemQty = stockRows[0]?.quantity ?? "0";
    const unitCost = stockRows[0]?.unit_cost ?? null;

    const variance = new Decimal(countedQty).minus(systemQty);
    // No cost basis yet means the quantity is still wrong and worth fixing, but
    // there is no value to move — the ledger stays out of it rather than
    // inventing a price.
    const varianceValue = unitCost === null ? new Decimal(0) : variance.times(unitCost).toDecimalPlaces(0);

    if (varianceValue.isNegative()) shortage = shortage.plus(varianceValue.abs());
    else surplus = surplus.plus(varianceValue);

    await client.query(
      `INSERT INTO item_stock (item_id, quantity) VALUES ($1, $2)
       ON CONFLICT (item_id) DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()`,
      [itemId, countedQty],
    );
    await client.query(
      `INSERT INTO item_stock_count_lines
         (stock_count_id, item_id, system_qty, counted_qty, variance, unit_cost, variance_value)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [countId, itemId, systemQty, countedQty, variance.toFixed(), unitCost, varianceValue.toFixed()],
    );
  }

  const { entryId } = await emitDomainEvent(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    eventType: "retail.stock_count_adjustment",
    payload: {
      countId,
      shortage: rialText(shortage.toFixed()) as RialText,
      surplus: rialText(surplus.toFixed()) as RialText,
    },
    sourceType: "item_stock_count",
    sourceId: countId,
    createdBy: params.createdBy,
  });
  if (entryId) {
    await client.query("UPDATE item_stock_counts SET entry_id = $2 WHERE id = $1", [countId, entryId]);
  }

  return { id: countId, entryId, shortage: shortage.toFixed(), surplus: surplus.toFixed() };
}

/**
 * Undoes a posted count: each line's variance is taken back out of stock and
 * the variance entry is reversed at the value originally recorded.
 *
 * Refused when a surplus this count added has since been sold — putting it back
 * would drive the quantity negative, which `item_stock` forbids and which would
 * mean re-costing sales that already happened. A fresh count is the answer
 * there, exactly as on the F&B side.
 */
export async function reverseItemStockCount(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    countId: string;
    createdBy: string | null;
    note?: string | null;
  },
): Promise<{ id: string; entryId: string | null }> {
  const { rows: counts } = await client.query<{ id: string; reversal_of: string | null }>(
    `SELECT id, reversal_of FROM item_stock_counts
      WHERE id = $1 AND location_id = $2 FOR UPDATE`,
    [params.countId, params.locationId],
  );
  const count = counts[0];
  if (!count) throw new Error("count_not_found");
  if (count.reversal_of) throw new Error("count_not_reversible");

  const { rows: already } = await client.query(
    "SELECT 1 FROM item_stock_counts WHERE reversal_of = $1 LIMIT 1",
    [params.countId],
  );
  if (already.length) throw new Error("already_reversed");

  const { rows: lines } = await client.query<{
    item_id: string;
    variance: string;
    variance_value: string;
  }>(
    `SELECT item_id, variance::text, variance_value::text
       FROM item_stock_count_lines WHERE stock_count_id = $1 ORDER BY item_id`,
    [params.countId],
  );

  const itemIds = lines.map((l) => l.item_id);
  if (itemIds.length > 0) {
    await client.query("SELECT id FROM items WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE", [itemIds]);
  }

  const { rows: reversalRows } = await client.query<{ id: string }>(
    `INSERT INTO item_stock_counts (business_id, location_id, note, counted_by, reversal_of)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [params.businessId, params.locationId, params.note?.trim() || null, params.createdBy, params.countId],
  );
  const reversalId = reversalRows[0].id;

  let shortage = new Decimal(0);
  let surplus = new Decimal(0);

  for (const line of lines) {
    const variance = new Decimal(line.variance);
    const value = new Decimal(line.variance_value);
    if (value.isNegative()) shortage = shortage.plus(value.abs());
    else surplus = surplus.plus(value);

    if (variance.isZero()) continue;

    const { rows: stockRows } = await client.query<{ quantity: string }>(
      "SELECT quantity::text FROM item_stock WHERE item_id = $1 FOR UPDATE",
      [line.item_id],
    );
    const current = new Decimal(stockRows[0]?.quantity ?? "0");
    const restored = current.minus(variance);
    if (restored.isNegative()) throw new Error("count_stock_consumed");

    await client.query(
      `INSERT INTO item_stock (item_id, quantity) VALUES ($1, $2)
       ON CONFLICT (item_id) DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()`,
      [line.item_id, restored.toFixed(9)],
    );
  }

  const { entryId } = await emitDomainEvent(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    eventType: "retail.stock_count_reversal",
    payload: {
      countId: reversalId,
      reversalOf: params.countId,
      shortage: rialText(shortage.toFixed()) as RialText,
      surplus: rialText(surplus.toFixed()) as RialText,
    },
    sourceType: "item_stock_count",
    sourceId: reversalId,
    createdBy: params.createdBy,
  });
  if (entryId) {
    await client.query("UPDATE item_stock_counts SET entry_id = $2 WHERE id = $1", [reversalId, entryId]);
  }

  return { id: reversalId, entryId };
}

export interface ItemStockCountSummary {
  id: string;
  note: string | null;
  countedAt: string;
  countedByName: string | null;
  lineCount: number;
  shortageValue: string;
  surplusValue: string;
  reversed: boolean;
}

/** Recent counts at this branch, newest first. Reversal rows are folded into
 *  the count they undo rather than listed as counts of their own. */
export async function listItemStockCounts(
  client: PoolClient,
  locationId: string,
  limit = 50,
): Promise<ItemStockCountSummary[]> {
  const { rows } = await client.query<{
    id: string;
    note: string | null;
    counted_at: string;
    counted_by_name: string | null;
    line_count: string;
    shortage_value: string;
    surplus_value: string;
    reversed: boolean;
  }>(
    `SELECT c.id, c.note, c.counted_at::text, u.full_name AS counted_by_name,
            (SELECT count(*) FROM item_stock_count_lines l WHERE l.stock_count_id = c.id)::text AS line_count,
            COALESCE((SELECT sum(-l.variance_value) FROM item_stock_count_lines l
                       WHERE l.stock_count_id = c.id AND l.variance_value < 0), 0)::text AS shortage_value,
            COALESCE((SELECT sum(l.variance_value) FROM item_stock_count_lines l
                       WHERE l.stock_count_id = c.id AND l.variance_value > 0), 0)::text AS surplus_value,
            EXISTS (SELECT 1 FROM item_stock_counts r WHERE r.reversal_of = c.id) AS reversed
       FROM item_stock_counts c
       LEFT JOIN users u ON u.id = c.counted_by
      WHERE c.location_id = $1 AND c.reversal_of IS NULL
      ORDER BY c.counted_at DESC
      LIMIT $2`,
    [locationId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    note: r.note,
    countedAt: r.counted_at,
    countedByName: r.counted_by_name,
    lineCount: Number(r.line_count),
    shortageValue: r.shortage_value,
    surplusValue: r.surplus_value,
    reversed: r.reversed,
  }));
}

/** One count's header and lines, scoped to the caller's branch. */
export async function getItemStockCountDetail(
  client: PoolClient,
  params: { locationId: string; countId: string },
): Promise<ItemStockCountDetail | null> {
  const { rows: counts } = await client.query<{
    id: string;
    note: string | null;
    counted_at: string;
    counted_by_name: string | null;
    entry_id: string | null;
    reversed_at: string | null;
  }>(
    `SELECT c.id, c.note, c.counted_at::text, u.full_name AS counted_by_name, c.entry_id,
            (SELECT r.counted_at::text FROM item_stock_counts r WHERE r.reversal_of = c.id) AS reversed_at
       FROM item_stock_counts c
       LEFT JOIN users u ON u.id = c.counted_by
      WHERE c.id = $1 AND c.location_id = $2 AND c.reversal_of IS NULL`,
    [params.countId, params.locationId],
  );
  if (!counts[0]) return null;

  const { rows: lines } = await client.query<{
    id: string;
    item_id: string;
    item_name: string;
    system_qty: string;
    counted_qty: string;
    variance: string;
    unit_cost: string | null;
    variance_value: string;
  }>(
    `SELECT l.id, l.item_id, i.name AS item_name,
            trim_scale(l.system_qty)::text AS system_qty,
            trim_scale(l.counted_qty)::text AS counted_qty,
            trim_scale(l.variance)::text AS variance,
            l.unit_cost::text, l.variance_value::text
       FROM item_stock_count_lines l
       JOIN items i ON i.id = l.item_id
      WHERE l.stock_count_id = $1
      ORDER BY i.name, l.id`,
    [params.countId],
  );

  return {
    id: counts[0].id,
    note: counts[0].note,
    countedAt: counts[0].counted_at,
    countedByName: counts[0].counted_by_name,
    entryId: counts[0].entry_id,
    reversedAt: counts[0].reversed_at,
    lines: lines.map((l) => ({
      id: l.id,
      itemId: l.item_id,
      itemName: l.item_name,
      systemQty: l.system_qty,
      countedQty: l.counted_qty,
      variance: l.variance,
      unitCost: l.unit_cost,
      varianceValue: l.variance_value,
    })),
  };
}
