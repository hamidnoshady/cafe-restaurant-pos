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
import { isUuid } from "./uuid";

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

/**
 * A list name is a column header on a wide matrix; anything longer is a paste
 * accident that would push every price column off the screen. The database
 * column is unbounded `text`, so the limit is enforced here for both the
 * create and the rename path.
 */
const MAX_NAME_LENGTH = 60;

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
  if (name.length > MAX_NAME_LENGTH) return { error: "name_too_long" };
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

/**
 * Renames one list *of this branch*. The location is part of the WHERE rather
 * than assumed from RLS: `app_owns_location` answers at business granularity,
 * so a business with two branches could otherwise rename the other branch's
 * list by id. `isUuid` runs first because `WHERE id = $1` against a `uuid`
 * column raises a syntax error — a 500 — instead of matching no rows.
 */
export async function renamePriceList(
  id: string,
  name: string,
  locationId: string,
): Promise<{ list?: PriceList; error?: string }> {
  if (!isUuid(id)) return { error: "not_found" };
  const trimmed = name.trim();
  if (!trimmed) return { error: "missing_fields" };
  if (trimmed.length > MAX_NAME_LENGTH) return { error: "name_too_long" };
  try {
    const { rows } = await query<PriceListRow>(
      `UPDATE price_lists SET name = $2, updated_at = now()
        WHERE id = $1 AND location_id = $3
        RETURNING *`,
      [id, trimmed, locationId],
    );
    return rows[0] ? { list: mapList(rows[0]) } : { error: "not_found" };
  } catch (err) {
    if (isUniqueViolation(err)) return { error: "duplicate_name" };
    throw err;
  }
}

export async function deletePriceList(id: string, locationId: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const { rowCount } = await query(
    `DELETE FROM price_lists WHERE id = $1 AND location_id = $2`,
    [id, locationId],
  );
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

/**
 * One «ذخیره قیمت‌ها» press: upsert the filled cells, delete the cleared ones.
 *
 * Two properties the previous row-at-a-time loop did not have:
 *
 *   * **Branch scoping.** Both the list and the item are required to belong to
 *     `locationId`. RLS only proves the row belongs to the *business*, so a
 *     two-branch business could otherwise write a price onto the other
 *     branch's list by posting its id. Non-uuid ids are dropped before the
 *     query, where they would raise a syntax error rather than match nothing.
 *
 *   * **One round trip per kind.** A 300-row matrix with three list columns
 *     used to issue up to 900 sequential statements — tens of seconds, and a
 *     failure halfway left the matrix half-saved. The upserts now go in a
 *     single statement via `unnest`, and the deletes in a single statement, so
 *     a save is atomic per kind and returns in one hop.
 */
export async function savePriceEntries(
  updates: EntryUpdate[],
  locationId: string,
): Promise<number> {
  const valid = updates.filter(
    (u) =>
      isUuid(u.priceListId) &&
      isUuid(u.itemId) &&
      (u.price === null || (Number.isFinite(u.price) && u.price >= 0)),
  );
  // Last write wins when the same cell appears twice in one payload, which
  // keeps the `unnest` upsert from raising "cannot affect row a second time".
  const deduped = new Map<string, EntryUpdate>();
  for (const update of valid) deduped.set(`${update.priceListId}:${update.itemId}`, update);
  const cells = [...deduped.values()];

  const clears = cells.filter((u) => u.price === null);
  const writes = cells.filter((u) => u.price !== null);
  let touched = 0;

  if (clears.length > 0) {
    const { rowCount } = await query(
      `DELETE FROM price_list_entries e
        USING price_lists l, unnest($1::uuid[], $2::uuid[]) AS t(price_list_id, item_id)
        WHERE e.price_list_id = t.price_list_id
          AND e.item_id = t.item_id
          AND l.id = e.price_list_id
          AND l.location_id = $3`,
      [clears.map((u) => u.priceListId), clears.map((u) => u.itemId), locationId],
    );
    touched += rowCount ?? 0;
  }

  if (writes.length > 0) {
    const { rowCount } = await query(
      `INSERT INTO price_list_entries (price_list_id, item_id, price)
       SELECT t.price_list_id, t.item_id, t.price
         FROM unnest($1::uuid[], $2::uuid[], $3::bigint[]) AS t(price_list_id, item_id, price)
         JOIN price_lists l ON l.id = t.price_list_id AND l.location_id = $4
         JOIN items i ON i.id = t.item_id AND i.location_id = $4
       ON CONFLICT (price_list_id, item_id)
       DO UPDATE SET price = EXCLUDED.price, updated_at = now()`,
      [
        writes.map((u) => u.priceListId),
        writes.map((u) => u.itemId),
        writes.map((u) => Math.round(u.price as number)),
        locationId,
      ],
    );
    touched += rowCount ?? 0;
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

/**
 * A percent move is a *ratio*, so `value` is bounded below at -100: anything
 * further would flip a price negative, and the clamp at zero would silently
 * turn "-500%" into "free". An amount move is already in Rial and may be any
 * finite number; the result is clamped at zero either way.
 */
export const MIN_PERCENT = -100;
export const MAX_PERCENT = 10_000;

export function isValidQuickUpdateValue(mode: "percent" | "amount", value: number): boolean {
  if (!Number.isFinite(value)) return false;
  if (mode === "percent") return value >= MIN_PERCENT && value <= MAX_PERCENT;
  return Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

/**
 * Rounding to the nearest thousand Toman must never round a real price *down
 * to zero* — «۴٬۰۰۰ ریال» would become «۰», i.e. unpriced, which for the sale
 * column then fails the `> 0` check and silently leaves the old price. So a
 * positive result keeps at least one rounding unit.
 */
export function applyQuickUpdate(
  current: number,
  input: Pick<QuickUpdateInput, "mode" | "value" | "round">,
): number {
  const next =
    input.mode === "percent" ? current * (1 + input.value / 100) : current + input.value;
  const clamped = Math.max(0, Math.round(next));
  if (!input.round) return clamped;
  const rounded = Math.round(clamped / ROUND_UNIT) * ROUND_UNIT;
  return rounded === 0 && clamped > 0 ? ROUND_UNIT : rounded;
}

/**
 * «بروزرسانی سریع» — one percent/amount move over a whole column.
 *
 * Done as a single `UPDATE … FROM` per target rather than a select-then-update
 * loop: the loop issued one statement per row (a 2,000-item branch meant 2,001
 * round trips), and because the read and the writes were separate statements a
 * concurrent edit between them was silently overwritten with a value derived
 * from a stale price. The arithmetic is kept in SQL so it applies to the row as
 * it exists at write time.
 *
 * The return value is the number of rows actually *changed*, not the number
 * read — the sale column's `> 0` check means a row can be read and not written,
 * and reporting it as changed made «بروزرسانی سریع» claim work it had not done.
 */
export async function quickUpdatePrices(input: QuickUpdateInput): Promise<number> {
  if (!isValidQuickUpdateValue(input.mode, input.value)) return 0;
  const itemIds = input.itemIds.filter(isUuid);
  if (input.itemIds.length > 0 && itemIds.length === 0) return 0;
  const scope = itemIds.length ? itemIds : null;

  // The shared arithmetic, in SQL: percent scales, amount adds, the result is
  // clamped at zero and optionally snapped to the nearest thousand Toman
  // (never down to zero — see `applyQuickUpdate`).
  const moved =
    input.mode === "percent" ? `(%COL% * (1 + %VAL%::numeric / 100))` : `(%COL% + %VAL%::numeric)`;
  const clamped = `GREATEST(0, round(${moved}))`;
  const expression = input.round
    ? `CASE WHEN ${clamped} > 0 AND round(${clamped} / ${ROUND_UNIT}) * ${ROUND_UNIT} = 0
             THEN ${ROUND_UNIT}
             ELSE round(${clamped} / ${ROUND_UNIT}) * ${ROUND_UNIT} END`
    : clamped;

  /** Bind the column and the value placeholder for one branch's numbering. */
  const sql = (template: string, col: string, valueParam: string) =>
    template.replaceAll("%COL%", col).replaceAll("%VAL%", valueParam);

  if (input.target.kind === "list") {
    if (!isUuid(input.target.priceListId)) return 0;
    const { rowCount } = await query(
      `UPDATE price_list_entries e
          SET price = (${sql(expression, "e.price", "$4")})::bigint,
              updated_at = now()
         FROM price_lists l
        WHERE l.id = e.price_list_id
          AND l.location_id = $1
          AND e.price_list_id = $2
          AND ($3::uuid[] IS NULL OR e.item_id = ANY($3::uuid[]))`,
      [input.locationId, input.target.priceListId, scope, input.value],
    );
    return rowCount ?? 0;
  }

  const column = input.target.kind === "sale" ? "unit_price" : "unit_cost";
  // `unit_price` carries a `> 0` check: a shelf price of exactly zero means
  // "unpriced", not "free", so a reduction that lands on zero leaves the old
  // price rather than violating the constraint.
  const guard = input.target.kind === "sale" ? `AND (${sql(expression, `s.${column}`, "$3")}) > 0` : "";
  const { rowCount } = await query(
    `UPDATE item_stock s
        SET ${column} = (${sql(expression, `s.${column}`, "$3")})::bigint,
            updated_at = now()
       FROM items i
      WHERE i.id = s.item_id
        AND i.location_id = $1
        AND s.${column} IS NOT NULL
        AND ($2::uuid[] IS NULL OR s.item_id = ANY($2::uuid[]))
        ${guard}`,
    [input.locationId, scope, input.value],
  );
  return rowCount ?? 0;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}
