/**
 * Phase 21 Wave 1 — generic Item/Variant/Serial primitive (DB-touching).
 *
 * A shared "sellable thing" model for the industries this phase adds:
 * a watch is a `tracking: 'serial'` item (one item_serials row per physical
 * unit), an accessory is a `kind: 'variant_child'` item under a
 * `variant_parent`, and a weighted gold piece (Wave 2) will attach its own
 * weight/purity attributes on top of the same `items` row. F&B's own
 * `menu_items`/`inventory_items`/recipes are deliberately untouched in this
 * wave — see Phase-21-Multi-Industry-Accounting-Platform.md's progress notes
 * for why migrating them onto this primitive is its own follow-up slice.
 *
 * DB-touching, so per repo convention (see items.ts for the pure rules this
 * leans on) it has no direct unit test; covered instead by
 * integration/generic-items.integration.test.ts.
 */
import { getPool, query, type PoolClient } from "./db";
import {
  validateItemKindParent,
  validateSerialNumber,
  validateSerialStatusTransition,
  validateVariantAttributes,
  validateWeightItemStatusTransition,
  type ItemKind,
  type ItemTracking,
  type SerialStatus,
  type VariantAttributeInput,
  type WeightItemStatus,
} from "./items";
import { validateStone, validateWeightAttributes, type Purity, type StoneInput } from "./gold";

export interface Item {
  id: string;
  locationId: string;
  parentItemId: string | null;
  name: string;
  sku: string | null;
  kind: ItemKind;
  tracking: ItemTracking;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ItemSerial {
  id: string;
  itemId: string;
  serialNumber: string;
  status: SerialStatus;
  createdAt: string;
}

export interface VariantAttribute {
  id: string;
  itemId: string;
  name: string;
  value: string;
}

interface ItemRow extends Record<string, unknown> {
  id: string;
  location_id: string;
  parent_item_id: string | null;
  name: string;
  sku: string | null;
  kind: ItemKind;
  tracking: ItemTracking;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

function mapItem(row: ItemRow): Item {
  return {
    id: row.id,
    locationId: row.location_id,
    parentItemId: row.parent_item_id,
    name: row.name,
    sku: row.sku,
    kind: row.kind,
    tracking: row.tracking,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateItemInput {
  locationId: string;
  name: string;
  sku?: string | null;
  kind?: ItemKind;
  tracking?: ItemTracking;
  parentItemId?: string | null;
}

/** Creates a `simple` (default) item, or a bare `variant_parent` with no attributes of its own — use createVariantChild for its children. */
export async function createItem(input: CreateItemInput): Promise<Item> {
  const kind = input.kind ?? "simple";
  const parentItemId = input.parentItemId ?? null;
  if (kind === "variant_child") {
    throw new Error("از createVariantChild برای ایجاد کالای تنوع فرزند استفاده کنید.");
  }
  const error = validateItemKindParent(kind, parentItemId);
  if (error) throw new Error(error);

  const { rows } = await query<ItemRow>(
    `INSERT INTO items (location_id, parent_item_id, name, sku, kind, tracking)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [input.locationId, parentItemId, input.name, input.sku ?? null, kind, input.tracking ?? "none"],
  );
  return mapItem(rows[0]);
}

/** Creates one variant of a `variant_parent` item, with its distinguishing attributes, atomically. */
export async function createVariantChild(
  parentItemId: string,
  locationId: string,
  name: string,
  sku: string | null,
  attributes: VariantAttributeInput[],
): Promise<Item> {
  const errors = validateVariantAttributes(attributes);
  if (errors.length > 0) throw new Error(errors.join("؛ "));

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<ItemRow>(
      `INSERT INTO items (location_id, parent_item_id, name, sku, kind)
       VALUES ($1, $2, $3, $4, 'variant_child') RETURNING *`,
      [locationId, parentItemId, name, sku],
    );
    const item = mapItem(rows[0]);
    for (const a of attributes) {
      await client.query(
        `INSERT INTO item_variant_attributes (item_id, name, value) VALUES ($1, $2, $3)`,
        [item.id, a.name.trim(), a.value.trim()],
      );
    }
    await client.query("COMMIT");
    return item;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listItems(locationId: string): Promise<Item[]> {
  const { rows } = await query<ItemRow>(
    `SELECT * FROM items WHERE location_id = $1 ORDER BY name`,
    [locationId],
  );
  return rows.map(mapItem);
}

export async function listVariantChildren(parentItemId: string): Promise<Item[]> {
  const { rows } = await query<ItemRow>(
    `SELECT * FROM items WHERE parent_item_id = $1 ORDER BY name`,
    [parentItemId],
  );
  return rows.map(mapItem);
}

export async function getItem(id: string): Promise<Item | null> {
  const { rows } = await query<ItemRow>(`SELECT * FROM items WHERE id = $1`, [id]);
  return rows[0] ? mapItem(rows[0]) : null;
}

export async function listVariantAttributes(itemId: string): Promise<VariantAttribute[]> {
  const { rows } = await query<{ id: string; item_id: string; name: string; value: string }>(
    `SELECT * FROM item_variant_attributes WHERE item_id = $1 ORDER BY name`,
    [itemId],
  );
  return rows.map((r) => ({ id: r.id, itemId: r.item_id, name: r.name, value: r.value }));
}

interface SerialRow extends Record<string, unknown> {
  id: string;
  item_id: string;
  serial_number: string;
  status: SerialStatus;
  created_at: string;
}

function mapSerial(row: SerialRow): ItemSerial {
  return {
    id: row.id,
    itemId: row.item_id,
    serialNumber: row.serial_number,
    status: row.status,
    createdAt: row.created_at,
  };
}

/** Registers one physical unit of a `tracking: 'serial'` item (Wave 5: watches). */
export async function addSerial(itemId: string, serialNumber: string): Promise<ItemSerial> {
  const error = validateSerialNumber(serialNumber);
  if (error) throw new Error(error);

  const item = await getItem(itemId);
  if (!item) throw new Error("کالا یافت نشد.");
  if (item.tracking !== "serial") {
    throw new Error("فقط کالای با ردیابی «سریال» می‌تواند شماره سریال داشته باشد.");
  }

  const { rows } = await query<SerialRow>(
    `INSERT INTO item_serials (item_id, serial_number) VALUES ($1, $2) RETURNING *`,
    [itemId, serialNumber.trim()],
  );
  return mapSerial(rows[0]);
}

export async function listSerials(itemId: string): Promise<ItemSerial[]> {
  const { rows } = await query<SerialRow>(
    `SELECT * FROM item_serials WHERE item_id = $1 ORDER BY serial_number`,
    [itemId],
  );
  return rows.map(mapSerial);
}

export async function setSerialStatus(
  id: string,
  status: SerialStatus,
  client?: PoolClient,
): Promise<ItemSerial> {
  const run = <T extends Record<string, unknown>>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params as never) : query<T>(text, params);

  const { rows: existing } = await run<SerialRow>(`SELECT * FROM item_serials WHERE id = $1`, [id]);
  const current = existing[0];
  if (!current) throw new Error("سریال یافت نشد.");

  const error = validateSerialStatusTransition(current.status, status);
  if (error) throw new Error(error);

  const { rows } = await run<SerialRow>(
    `UPDATE item_serials SET status = $1 WHERE id = $2 RETURNING *`,
    [status, id],
  );
  return mapSerial(rows[0]);
}

export interface ItemWeightAttributes {
  itemId: string;
  purity: Purity;
  grossWeight: string;
  netWeight: string;
  unitCostPerGram: string | null;
  status: WeightItemStatus;
}

interface WeightAttributesRow extends Record<string, unknown> {
  item_id: string;
  purity: Purity;
  gross_weight: string;
  net_weight: string;
  unit_cost_per_gram: string | null;
  status: WeightItemStatus;
}

function mapWeightAttributes(row: WeightAttributesRow): ItemWeightAttributes {
  return {
    itemId: row.item_id,
    purity: row.purity,
    grossWeight: row.gross_weight,
    netWeight: row.net_weight,
    unitCostPerGram: row.unit_cost_per_gram,
    status: row.status,
  };
}

/** Sets (creates or replaces) the weight/purity/cost attributes of a `tracking: 'weight'` item — Wave 2/3's gold/jewelry pieces. Leaves `status` alone on an update (use setWeightItemStatus for that) and defaults a new row to `in_stock`. */
export async function setWeightAttributes(
  itemId: string,
  input: { purity: string; grossWeight: string; netWeight: string; unitCostPerGram?: string | null },
): Promise<ItemWeightAttributes> {
  const errors = validateWeightAttributes(input);
  if (errors.length > 0) throw new Error(errors.join("؛ "));

  const item = await getItem(itemId);
  if (!item) throw new Error("کالا یافت نشد.");
  if (item.tracking !== "weight") {
    throw new Error("فقط کالای با ردیابی «وزنی» می‌تواند ویژگی وزن/عیار داشته باشد.");
  }

  const { rows } = await query<WeightAttributesRow>(
    `INSERT INTO item_weight_attributes (item_id, purity, gross_weight, net_weight, unit_cost_per_gram)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (item_id) DO UPDATE
       SET purity = EXCLUDED.purity, gross_weight = EXCLUDED.gross_weight,
           net_weight = EXCLUDED.net_weight, unit_cost_per_gram = EXCLUDED.unit_cost_per_gram,
           updated_at = now()
     RETURNING *`,
    [itemId, input.purity, input.grossWeight, input.netWeight, input.unitCostPerGram ?? null],
  );
  return mapWeightAttributes(rows[0]);
}

export async function getWeightAttributes(itemId: string): Promise<ItemWeightAttributes | null> {
  const { rows } = await query<WeightAttributesRow>(
    `SELECT * FROM item_weight_attributes WHERE item_id = $1`,
    [itemId],
  );
  return rows[0] ? mapWeightAttributes(rows[0]) : null;
}

export async function setWeightItemStatus(
  itemId: string,
  status: WeightItemStatus,
  client?: PoolClient,
): Promise<ItemWeightAttributes> {
  const run = <T extends Record<string, unknown>>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params as never) : query<T>(text, params);

  const { rows: existing } = await run<WeightAttributesRow>(
    `SELECT * FROM item_weight_attributes WHERE item_id = $1`,
    [itemId],
  );
  const current = existing[0];
  if (!current) throw new Error("ویژگی وزن/عیار برای این کالا ثبت نشده است.");

  const error = validateWeightItemStatusTransition(current.status, status);
  if (error) throw new Error(error);

  const { rows } = await run<WeightAttributesRow>(
    `UPDATE item_weight_attributes SET status = $1, updated_at = now() WHERE item_id = $2 RETURNING *`,
    [status, itemId],
  );
  return mapWeightAttributes(rows[0]);
}

export interface ItemStone {
  id: string;
  itemId: string;
  stoneType: string;
  carat: string;
  cost: number;
  createdAt: string;
}

interface StoneRow extends Record<string, unknown> {
  id: string;
  item_id: string;
  stone_type: string;
  carat: string;
  // bigint comes back from pg as a string (see gold-prices-service.ts) --
  // converted to a plain number in mapStone.
  cost: string;
  created_at: string;
}

function mapStone(row: StoneRow): ItemStone {
  return {
    id: row.id,
    itemId: row.item_id,
    stoneType: row.stone_type,
    carat: row.carat,
    cost: Number(row.cost),
    createdAt: row.created_at,
  };
}

/** Adds a gem/stone cost add-on to a `tracking: 'weight'` item — Wave 4's jewelry pieces. An item may carry several. */
export async function addStone(itemId: string, input: StoneInput): Promise<ItemStone> {
  const errors = validateStone(input);
  if (errors.length > 0) throw new Error(errors.join("؛ "));

  const item = await getItem(itemId);
  if (!item) throw new Error("کالا یافت نشد.");
  if (item.tracking !== "weight") {
    throw new Error("فقط کالای با ردیابی «وزنی» می‌تواند سنگ داشته باشد.");
  }

  const { rows } = await query<StoneRow>(
    `INSERT INTO item_stones (item_id, stone_type, carat, cost) VALUES ($1, $2, $3, $4) RETURNING *`,
    [itemId, input.stoneType.trim(), input.carat, input.cost],
  );
  return mapStone(rows[0]);
}

export async function listStones(itemId: string): Promise<ItemStone[]> {
  const { rows } = await query<StoneRow>(
    `SELECT * FROM item_stones WHERE item_id = $1 ORDER BY created_at`,
    [itemId],
  );
  return rows.map(mapStone);
}

export async function removeStone(id: string): Promise<void> {
  await query(`DELETE FROM item_stones WHERE id = $1`, [id]);
}

/** Sum of an item's stone costs (0 if it has none) — the add-on to metal cost when computing COGS at sale time. */
export async function totalStoneCost(itemId: string, client?: PoolClient): Promise<number> {
  const run = <T extends Record<string, unknown>>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params as never) : query<T>(text, params);

  const { rows } = await run<{ total: string | null }>(
    `SELECT SUM(cost)::text AS total FROM item_stones WHERE item_id = $1`,
    [itemId],
  );
  return Number(rows[0]?.total ?? 0);
}
