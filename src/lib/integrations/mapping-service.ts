/**
 * Phase 23 (issue #118) — remote id ↔ local id mapping (DB-touching).
 * One mapping row per (connection, entity_type, remote_id); the unique index
 * is the idempotency backbone for order import and the lookup used to diff
 * stock/price pushes against the last-pushed value.
 */
import { query } from "../db";

export type MappingEntityType =
  | "product"
  | "customer"
  | "order"
  | "refund"
  // Phase 26 — Holoo entity kinds (Waves 3–8). See migrations/0104.
  | "holoo_goods"
  | "holoo_customer"
  | "holoo_account"
  | "holoo_invoice"
  | "holoo_purchase"
  | "holoo_receipt"
  | "holoo_stock"
  | "holoo_journal"
  | "holoo_document";

export async function upsertMapping(
  businessId: string,
  connectionId: string,
  entityType: MappingEntityType,
  remoteId: string,
  localId: string,
): Promise<void> {
  await query(
    `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (connection_id, entity_type, remote_id)
     DO UPDATE SET local_id = EXCLUDED.local_id, updated_at = now()`,
    [businessId, connectionId, entityType, remoteId, localId],
  );
}

export async function localIdForRemote(
  businessId: string,
  connectionId: string,
  entityType: MappingEntityType,
  remoteId: string,
): Promise<string | null> {
  const { rows } = await query<{ local_id: string }>(
    `SELECT local_id FROM integration_mappings
      WHERE business_id = $1 AND connection_id = $2 AND entity_type = $3 AND remote_id = $4`,
    [businessId, connectionId, entityType, remoteId],
  );
  return rows[0]?.local_id ?? null;
}

export interface MappingRow {
  entityType: MappingEntityType;
  remoteId: string;
  localId: string;
  lastPushedPayload: unknown;
}

export async function listMappings(
  businessId: string,
  connectionId: string,
  entityType: MappingEntityType,
): Promise<MappingRow[]> {
  const { rows } = await query<{ entity_type: MappingEntityType; remote_id: string; local_id: string; last_pushed_payload: unknown }>(
    `SELECT entity_type, remote_id, local_id, last_pushed_payload
       FROM integration_mappings
      WHERE business_id = $1 AND connection_id = $2 AND entity_type = $3`,
    [businessId, connectionId, entityType],
  );
  return rows.map((r) => ({
    entityType: r.entity_type,
    remoteId: r.remote_id,
    localId: r.local_id,
    lastPushedPayload: r.last_pushed_payload,
  }));
}

/** Records the value that was last successfully pushed to the store. */
export async function setLastPushedPayload(
  businessId: string,
  connectionId: string,
  entityType: MappingEntityType,
  remoteId: string,
  payload: unknown,
): Promise<void> {
  await query(
    `UPDATE integration_mappings SET last_pushed_payload = $5, updated_at = now()
      WHERE business_id = $1 AND connection_id = $2 AND entity_type = $3 AND remote_id = $4`,
    [businessId, connectionId, entityType, remoteId, JSON.stringify(payload)],
  );
}
