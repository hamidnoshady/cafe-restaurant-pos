/**
 * Phase 21 Wave 4 — consignment (امانی). `consignors` mirrors
 * `customers-service.ts`'s shape and simplicity (a business-wide directory,
 * no separate pure-validation module — matching how customers/suppliers are
 * already validated inline in this codebase, not with dedicated pure
 * modules the way costing/pricing math is).
 *
 * `item_consignments` marks a `tracking: 'weight'` item as held for a
 * consignor rather than owned by the business — `gold-sales-service.ts`
 * checks this to route a sale through `gold.consignment_sale_revenue`
 * (src/lib/gold-posting-rules.ts) instead of the owned-inventory posting,
 * and to skip COGS entirely (the shop never owned the piece).
 *
 * DB-touching, so per repo convention it has no direct unit test; covered
 * instead by integration/consignment.integration.test.ts.
 */
import { query } from "./db";
import { getItem } from "./items-service";

export interface Consignor {
  id: string;
  businessId: string;
  name: string;
  phone: string | null;
  notes: string | null;
  createdAt: string;
}

interface ConsignorRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  name: string;
  phone: string | null;
  notes: string | null;
  created_at: string;
}

function mapConsignor(row: ConsignorRow): Consignor {
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    phone: row.phone,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

export async function createConsignor(
  businessId: string,
  input: { name: string; phone?: string | null; notes?: string | null },
): Promise<Consignor> {
  const name = input.name?.trim();
  if (!name) throw new Error("نام امانت‌گذار نمی‌تواند خالی باشد.");

  const { rows } = await query<ConsignorRow>(
    `INSERT INTO consignors (business_id, name, phone, notes) VALUES ($1, $2, $3, $4) RETURNING *`,
    [businessId, name, input.phone?.trim() || null, input.notes?.trim() || null],
  );
  return mapConsignor(rows[0]);
}

export async function listConsignors(businessId: string): Promise<Consignor[]> {
  const { rows } = await query<ConsignorRow>(
    `SELECT * FROM consignors WHERE business_id = $1 ORDER BY name`,
    [businessId],
  );
  return rows.map(mapConsignor);
}

export async function getConsignor(id: string): Promise<Consignor | null> {
  const { rows } = await query<ConsignorRow>(`SELECT * FROM consignors WHERE id = $1`, [id]);
  return rows[0] ? mapConsignor(rows[0]) : null;
}

export interface ItemConsignment {
  itemId: string;
  consignorId: string;
  createdAt: string;
}

interface ItemConsignmentRow extends Record<string, unknown> {
  item_id: string;
  consignor_id: string;
  created_at: string;
}

function mapItemConsignment(row: ItemConsignmentRow): ItemConsignment {
  return { itemId: row.item_id, consignorId: row.consignor_id, createdAt: row.created_at };
}

/** Marks a `tracking: 'weight'` item as held for a consignor — one-time, at intake; there is no "un-consign" (the item stays theirs until it's sold or returned, and a return is just deleting the item, not a status transition modeled here yet). */
export async function markAsConsigned(itemId: string, consignorId: string): Promise<ItemConsignment> {
  const item = await getItem(itemId);
  if (!item) throw new Error("کالا یافت نشد.");
  if (item.tracking !== "weight") {
    throw new Error("فقط کالای با ردیابی «وزنی» می‌تواند امانی باشد.");
  }
  const consignor = await getConsignor(consignorId);
  if (!consignor) throw new Error("امانت‌گذار یافت نشد.");

  const { rows } = await query<ItemConsignmentRow>(
    `INSERT INTO item_consignments (item_id, consignor_id) VALUES ($1, $2) RETURNING *`,
    [itemId, consignorId],
  );
  return mapItemConsignment(rows[0]);
}

export async function getConsignment(itemId: string): Promise<ItemConsignment | null> {
  const { rows } = await query<ItemConsignmentRow>(
    `SELECT * FROM item_consignments WHERE item_id = $1`,
    [itemId],
  );
  return rows[0] ? mapItemConsignment(rows[0]) : null;
}
