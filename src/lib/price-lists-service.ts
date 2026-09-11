/**
 * Phase 42 — named price lists («لیست قیمت») for the products workspace.
 *
 * `item_stock.unit_price` / `unit_cost` stay the sale and purchase price the
 * invoice screen reads; a price list is an *extra* named shelf column (عمده،
 * همکار، بازار…) whose cells live in `price_list_entries`. The update screen
 * therefore edits three kinds of column through one save: the two stock
 * prices (upserting `item_stock`, never touching quantity/cost semantics the
 * receipt path owns) and any number of list columns.
 *
 * «بروزرسانی سریع» applies one percent or fixed-amount move to a whole
 * column at once — the same arithmetic a shopkeeper does on paper — with an
 * optional round to the nearest thousand Toman so shelf prices end cleanly.
 */
import { query } from "./db";

export interface PriceList {
  id: string;
  locationId: string;
  name: string;
  currency: string;
  sort: number;
}

export interface PriceEntry {
  priceListId: string;
  itemId: string;
  price: number;
}

interface PriceListRow extends Record<string, unknown> {
  id: string;
  location_id: string;
  name: string;
  currency: string;
  sort: number;
}

interface EntryRow extends Record<string, unknown> {
  price_list_id: string;
  item_id: string;
  price: string | number;
}

function mapList(row: PriceListRow): PriceList {
  return {
    id: row.id,
    locationId: row.location_id,
    name: row.name,
    currency: row.currency,
    sort: row.sort,
  };
}

export async function listPriceLists(locationId: string): Promise<PriceList[]> {
  const { rows } = await query<PriceListRow>(
    `SELECT * FROM price_lists WHERE location_id = $1 ORDER BY sort, created_at`,
    [locationId],
  );
  return rows.map(mapList);
}

export async function createPriceList(input: {
  locationId: string;
  name: string;
  currency?: string;
}): Promise<{ list?: PriceList; error?: string }> {
  const name = input.name.trim();
  if (!name) return { error: "missing_fields" };
  try {
    const { rows } = await query<PriceListRow>(
      `INSERT INTO price_lists (location_id, name, currency, sort)
       VALUES ($1, $2, $3, (SELECT COALESCE(MAX(sort), 0) + 1 FROM price_lists WHERE location_id = $1))
       RETURNING *`,
      [input.locationId, name, input.currency?.trim() || "IRR"],
    );
    return { list: mapList(rows[0]) };
  } catch (err) {
    if (isUniqueViolation(err)) return { error: "duplicate_name" };
    throw err;
  }
}

export async function renamePriceList(
  id: string,
  name: string,
): Promise<{ list?: PriceList; error?: string }> {
  const trimmed = name.trim();
  if (!trimmed) return { error: "missing_fields" };
  try {
    const { rows } = await query<PriceListRow>(
      `UPDATE price_lists SET name = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, trimmed],
    );
    return rows[0] ? { list: mapList(rows[0]) } : { error: "not_found" };
  } catch (err) {
    if (isUniqueViolation(err)) return { error: "duplicate_name" };
    throw err;
  }
}

export async function deletePriceList(id: string): Promise<boolean> {
  const { rowCount } = await query(`DELETE FROM price_lists WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

export async function listPriceEntries(locationId: string): Promise<PriceEntry[]> {
  const { rows } = await query<EntryRow>(
    `SELECT e.price_list_id, e.item_id, e.price
       FROM price_list_entries e
       JOIN price_lists l ON l.id = e.price_list_id
      WHERE l.location_id = $1`,
    [locationId],
  );
  return rows.map((r) => ({
    priceListId: r.price_list_id,
    itemId: r.item_id,
    price: Number(r.price),
  }));
}

export interface EntryUpdate {
  priceListId: string;
  itemId: string;
  /** null clears the cell (the item has no price on this list). */
  price: number | null;
}

/** One save press: upsert the filled cells, delete the cleared ones. */
export async function savePriceEntries(updates: EntryUpdate[]): Promise<number> {
  let touched = 0;
  for (const update of updates) {
    if (update.price === null) {
      const { rowCount } = await query(
        `DELETE FROM price_list_entries WHERE price_list_id = $1 AND item_id = $2`,
        [update.priceListId, update.itemId],
      );
      touched += rowCount ?? 0;
      continue;
    }
    if (!Number.isFinite(update.price) || update.price < 0) continue;
    await query(
      `INSERT INTO price_list_entries (price_list_id, item_id, price)
       VALUES ($1, $2, $3)
       ON CONFLICT (price_list_id, item_id)
       DO UPDATE SET price = EXCLUDED.price, updated_at = now()`,
      [update.priceListId, update.itemId, Math.round(update.price)],
    );
    touched += 1;
  }
  return touched;
}

/** Which column «بروزرسانی سریع» moves. */
export type QuickUpdateTarget =
  | { kind: "sale" }
  | { kind: "purchase" }
  | { kind: "list"; priceListId: string };

export interface QuickUpdateInput {
  target: QuickUpdateTarget;
  mode: "percent" | "amount";
  /** percent: e.g. 10 for +10% (negative lowers); amount: Rial added per unit. */
  value: number;
  /** Round the result to the nearest thousand Toman (10,000 Rial). */
  round: boolean;
  /** Restrict to these items; empty = every item of the location. */
  itemIds: string[];
  locationId: string;
}

const ROUND_UNIT = 10_000; // a thousand Toman, in Rial

function applyOne(current: number, input: QuickUpdateInput): number {
  const next =
    input.mode === "percent"
      ? current * (1 + input.value / 100)
      : current + input.value;
  const floored = Math.max(0, Math.round(next));
  return input.round ? Math.round(floored / ROUND_UNIT) * ROUND_UNIT : floored;
}

export async function quickUpdatePrices(input: QuickUpdateInput): Promise<number> {
  if (!Number.isFinite(input.value)) return 0;
  if (input.target.kind === "list") {
    const { rows } = await query<EntryRow & { id: string }>(
      `SELECT e.id, e.price_list_id, e.item_id, e.price
         FROM price_list_entries e
         JOIN price_lists l ON l.id = e.price_list_id
        WHERE l.location_id = $1 AND e.price_list_id = $2
          AND ($3::uuid[] IS NULL OR e.item_id = ANY($3::uuid[]))`,
      [input.locationId, input.target.priceListId, input.itemIds.length ? input.itemIds : null],
    );
    for (const row of rows) {
      await query(
        `UPDATE price_list_entries SET price = $2, updated_at = now() WHERE id = $1`,
        [row.id, applyOne(Number(row.price), input)],
      );
    }
    return rows.length;
  }

  const column = input.target.kind === "sale" ? "unit_price" : "unit_cost";
  const { rows } = await query<{ item_id: string; price: string | number | null }>(
    `SELECT s.item_id, s.${column} AS price
       FROM item_stock s
       JOIN items i ON i.id = s.item_id
      WHERE i.location_id = $1 AND s.${column} IS NOT NULL
        AND ($2::uuid[] IS NULL OR s.item_id = ANY($2::uuid[]))`,
    [input.locationId, input.itemIds.length ? input.itemIds : null],
  );
  for (const row of rows) {
    const next = applyOne(Number(row.price), input);
    if (input.target.kind === "sale") {
      // unit_price carries a > 0 check; a reduction to zero keeps the old
      // price instead of violating it — a shelf price of exactly zero is
      // "unpriced", not "free".
      await query(
        `UPDATE item_stock SET unit_price = $2, updated_at = now() WHERE item_id = $1 AND $2 > 0`,
        [row.item_id, next],
      );
    } else {
      await query(
        `UPDATE item_stock SET unit_cost = $2, updated_at = now() WHERE item_id = $1`,
        [row.item_id, next],
      );
    }
  }
  return rows.length;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}
