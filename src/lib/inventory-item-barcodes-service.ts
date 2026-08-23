/**
 * Barcode assignment and lookup for F&B raw ingredients (DB-touching).
 *
 * The `inventory_items` counterpart of item-barcodes-service.ts, and
 * deliberately its mirror image rather than a generalisation of it: the two
 * item models never merge (Phase 21 Wave 1's settled scope decision), so a
 * shared abstraction here would be a seam across a boundary the rest of the
 * codebase keeps closed. What *is* shared is the part that matters — the pure
 * code format in src/lib/barcode.ts — so a single scanner reads both models'
 * labels with no configuration.
 *
 * One code = one ingredient per branch. Uniqueness is *also* enforced here, in
 * the service layer, with a Persian, operator-readable refusal — the DB
 * UNIQUE (location_id, code) constraint is the backstop, not the UX.
 */
import { randomInt } from "node:crypto";

import type { PoolClient } from "pg";

import { query } from "./db";
import {
  classifyBarcode,
  internalBarcodeForPayload,
  internalPayloadFromNumber,
  normalizeBarcode,
  type BarcodeSymbology,
} from "./barcode";

export interface InventoryItemBarcode {
  id: string;
  locationId: string;
  inventoryItemId: string;
  code: string;
  symbology: BarcodeSymbology;
  note: string | null;
}

interface BarcodeRow extends Record<string, unknown> {
  id: string;
  location_id: string;
  inventory_item_id: string;
  code: string;
  symbology: BarcodeSymbology;
  note: string | null;
}

function mapBarcode(row: BarcodeRow): InventoryItemBarcode {
  return {
    id: row.id,
    locationId: row.location_id,
    inventoryItemId: row.inventory_item_id,
    code: row.code,
    symbology: row.symbology,
    note: row.note,
  };
}

/** The ingredient's branch, or null when it is not this caller's to touch. */
async function locationOfItem(inventoryItemId: string): Promise<string | null> {
  const { rows } = await query<{ location_id: string }>(
    "SELECT location_id FROM inventory_items WHERE id = $1",
    [inventoryItemId],
  );
  return rows[0]?.location_id ?? null;
}

/** A supplier (EAN-13/UPC) or already-known code, or a minted internal one. */
export async function assignBarcode(
  inventoryItemId: string,
  input: { code?: string | null; symbology?: BarcodeSymbology | null; note?: string | null },
): Promise<InventoryItemBarcode> {
  const locationId = await locationOfItem(inventoryItemId);
  if (!locationId) throw new Error("کالای انبار یافت نشد.");

  const code = normalizeBarcode(input.code?.trim() ?? "");
  const symbology = input.symbology ?? (code ? classifyBarcode(code) : null);

  // A supplier code must actually be the symbology the caller claims, or be
  // rejected — a mistyped check digit would otherwise live in the table and
  // never scan.
  if (code && symbology && classifyBarcode(code) !== symbology) {
    throw new Error("بارکد با نوع انتخابی هم‌خوانی ندارد.");
  }

  if (code) {
    const { rows: existing } = await query<{ id: string }>(
      "SELECT id FROM inventory_item_barcodes WHERE location_id = $1 AND code = $2",
      [locationId, code],
    );
    if (existing[0]) {
      throw new Error("این بارکد قبلاً در همین شعبه برای کالای دیگری ثبت شده است.");
    }
  }

  const finalSymbology = symbology ?? "internal";
  const finalCode = code || (await mintUniqueInternalCode(locationId));

  const { rows } = await query<BarcodeRow>(
    `INSERT INTO inventory_item_barcodes (location_id, inventory_item_id, code, symbology, note)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [locationId, inventoryItemId, finalCode, finalSymbology, input.note?.trim() || null],
  );
  return mapBarcode(rows[0]);
}

/** Mint an internal code that is free at this branch, retrying the payload on the rare collision. */
async function mintUniqueInternalCode(locationId: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const payload = internalPayloadFromNumber(randomInt(100_000_000_000));
    const code = internalBarcodeForPayload(payload);
    const { rows } = await query<{ id: string }>(
      "SELECT id FROM inventory_item_barcodes WHERE location_id = $1 AND code = $2",
      [locationId, code],
    );
    if (!rows[0]) return code;
  }
  throw new Error("تولید بارکد داخلی ناموفق بود؛ دوباره تلاش کنید.");
}

export async function listBarcodes(inventoryItemId: string): Promise<InventoryItemBarcode[]> {
  const { rows } = await query<BarcodeRow>(
    "SELECT * FROM inventory_item_barcodes WHERE inventory_item_id = $1 ORDER BY created_at",
    [inventoryItemId],
  );
  return rows.map(mapBarcode);
}

export interface InventoryBarcodeLookupMatch {
  barcodeId: string;
  inventoryItemId: string;
  itemName: string;
  unit: string;
  code: string;
  symbology: BarcodeSymbology;
}

interface LookupRow extends Record<string, unknown> {
  barcode_id: string;
  inventory_item_id: string;
  item_name: string;
  unit: string;
  code: string;
  symbology: BarcodeSymbology;
}

/**
 * Resolve a scanned code at this branch. UNIQUE (location_id, code) means at
 * most one ingredient can match, but the result is still a list for the same
 * reason the retail lookup returns one: the caller surfaces ambiguity rather
 * than guessing, and "no match" and "one match" read the same way.
 */
export async function lookupBarcode(
  locationId: string,
  rawCode: string,
): Promise<InventoryBarcodeLookupMatch[]> {
  const code = normalizeBarcode(rawCode);
  const { rows } = await query<LookupRow>(
    `SELECT b.id AS barcode_id, b.inventory_item_id, b.code, b.symbology,
            i.name AS item_name, i.unit
       FROM inventory_item_barcodes b
       JOIN inventory_items i ON i.id = b.inventory_item_id
      WHERE b.location_id = $1 AND b.code = $2`,
    [locationId, code],
  );
  return rows.map((r) => ({
    barcodeId: r.barcode_id,
    inventoryItemId: r.inventory_item_id,
    itemName: r.item_name,
    unit: r.unit,
    code: r.code,
    symbology: r.symbology,
  }));
}

export interface UnbarcodedItem {
  id: string;
  name: string;
  unit: string;
}

/**
 * Ingredients at this branch carrying no code yet — what the bulk label run
 * has to mint for before a scan-driven count is possible at all.
 */
export async function listItemsWithoutBarcode(locationId: string): Promise<UnbarcodedItem[]> {
  const { rows } = await query<{ id: string; name: string; unit: string }>(
    `SELECT i.id, i.name, i.unit
       FROM inventory_items i
      WHERE i.location_id = $1
        AND i.is_active
        AND NOT EXISTS (SELECT 1 FROM inventory_item_barcodes b WHERE b.inventory_item_id = i.id)
      ORDER BY i.name`,
    [locationId],
  );
  return rows;
}

/**
 * Mint an internal code for every ingredient at this branch that has none.
 *
 * The bulk path exists because the realistic first run is a store room of
 * several thousand ingredients that have never been labelled: doing that one
 * HTTP request at a time is minutes of round trips, and half-finished if the
 * page is closed.
 *
 * Takes a caller-owned client (the repo's convention for anything that has to
 * participate in a transaction) so the whole branch is labelled or none of it
 * is — a partially-labelled store room is the one state that makes the count
 * screen lie, because an unlabelled ingredient is silently uncountable. It is
 * still safe to re-run: anything already carrying a code is skipped, so a run
 * interrupted by a rollback is simply repeated.
 */
export async function mintMissingBarcodes(
  client: PoolClient,
  locationId: string,
): Promise<{ minted: number; codes: Array<{ inventoryItemId: string; itemName: string; code: string }> }> {
  const { rows: pending } = await client.query<{ id: string; name: string }>(
    `SELECT i.id, i.name
       FROM inventory_items i
      WHERE i.location_id = $1
        AND i.is_active
        AND NOT EXISTS (SELECT 1 FROM inventory_item_barcodes b WHERE b.inventory_item_id = i.id)
      ORDER BY i.name`,
    [locationId],
  );

  const codes: Array<{ inventoryItemId: string; itemName: string; code: string }> = [];
  for (const item of pending) {
    const code = await mintUniqueInternalCodeOn(client, locationId);
    await client.query(
      `INSERT INTO inventory_item_barcodes (location_id, inventory_item_id, code, symbology)
       VALUES ($1, $2, $3, 'internal')`,
      [locationId, item.id, code],
    );
    codes.push({ inventoryItemId: item.id, itemName: item.name, code });
  }
  return { minted: codes.length, codes };
}

/**
 * The transactional twin of `mintUniqueInternalCode`. Codes minted earlier in
 * the same uncommitted transaction are invisible to a pool query, so the
 * collision check has to run on the same client that is doing the inserting.
 */
async function mintUniqueInternalCodeOn(client: PoolClient, locationId: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const payload = internalPayloadFromNumber(randomInt(100_000_000_000));
    const code = internalBarcodeForPayload(payload);
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM inventory_item_barcodes WHERE location_id = $1 AND code = $2",
      [locationId, code],
    );
    if (!rows.length) return code;
  }
  throw new Error("تولید بارکد داخلی ناموفق بود؛ دوباره تلاش کنید.");
}
