/**
 * Phase 38 — operating the store from the app, through the outbox.
 *
 * Phase 23's outbox could do exactly two things: set a stock number and set a
 * price. Both were automatic — a background diff pushed whatever the local
 * catalogue said, and no human ever chose to send anything. That is the right
 * design for a number and the wrong one for an action, so this module adds
 * the actions an owner actually asks for — mark that order completed, refund
 * those two lines, put that product on sale — and puts every one of them
 * through the same queue.
 *
 * Why the queue and not a direct call: half the stores this app connects to
 * are reachable only from the inside. In plugin mode the app holds no
 * credentials for the store and cannot dial it at all; the WordPress plugin
 * pulls these rows and applies them. Routing an operation through the outbox
 * is what makes «تغییر وضعیت سفارش» behave identically whether the store is
 * open to the internet or behind a firewall — and what gives it the retry,
 * the backoff and the dead-letter trail every push here already had.
 *
 * The fields an operation may send are closed lists, validated here. This
 * channel writes to a live shopfront, and "send whatever the dashboard sent"
 * is how a typo becomes a store-wide price change.
 */
import { query } from "../db";
import { writeIntegrationAudit } from "./audit";
import { parentRemoteIdFor } from "./sync-service";

export type OpsEntityType = "product_update" | "order_status" | "refund_create";

/**
 * Fields the app will write to a WooCommerce product.
 *
 * Deliberately narrow. `type`, `parent_id`, `sku`, `attributes` and
 * `categories` are all writable over REST and all absent here: changing one
 * from the POS would restructure a catalogue the store owns, and a mis-sent
 * `type` can orphan every variation a product has.
 */
export const PRODUCT_UPDATE_FIELDS = [
  "name",
  "regular_price",
  "sale_price",
  "stock_quantity",
  "manage_stock",
  "status",
  "description",
  "short_description",
] as const;
export type ProductUpdateField = (typeof PRODUCT_UPDATE_FIELDS)[number];

/** WooCommerce's canonical order statuses. */
export const ORDER_STATUSES = [
  "pending",
  "processing",
  "on-hold",
  "completed",
  "cancelled",
  "refunded",
  "failed",
] as const;
export type WooOrderStatus = (typeof ORDER_STATUSES)[number];

/** A product's publish status, which is a different axis from its order status. */
export const PRODUCT_STATUSES = ["publish", "draft", "pending", "private"] as const;

export class WooOpsError extends Error {}

/**
 * Filter a requested patch down to the fields this channel will write.
 *
 * Returns the filtered patch rather than throwing on an unknown key: the
 * dashboard is allowed to send a fuller object, and silently dropping
 * `type` is safer than rejecting a legitimate price change because the
 * caller also mentioned something we will not write.
 */
export function sanitizeProductPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of PRODUCT_UPDATE_FIELDS) {
    if (!(field in patch)) continue;
    const value = patch[field];
    if (value === undefined || value === null) continue;
    if (field === "stock_quantity" || field === "manage_stock") {
      if (field === "manage_stock") out[field] = Boolean(value);
      else {
        const quantity = Number(value);
        if (!Number.isFinite(quantity) || quantity < 0) throw new WooOpsError("invalid_stock_quantity");
        out[field] = Math.floor(quantity);
      }
      continue;
    }
    if (field === "regular_price" || field === "sale_price") {
      // Sent as a decimal string in the store's own unit, never as a number:
      // WooCommerce rejects a JSON number for prices, and a float would
      // round an amount the owner typed by hand.
      const text = String(value).trim();
      if (text !== "" && !/^\d+(?:\.\d+)?$/.test(text)) throw new WooOpsError("invalid_price");
      out[field] = text;
      continue;
    }
    if (field === "status") {
      const status = String(value);
      if (!(PRODUCT_STATUSES as readonly string[]).includes(status)) throw new WooOpsError("invalid_product_status");
      out[field] = status;
      continue;
    }
    out[field] = String(value);
  }
  if (Object.keys(out).length === 0) throw new WooOpsError("empty_patch");
  return out;
}

export function sanitizeOrderStatus(status: string): WooOrderStatus {
  if (!(ORDER_STATUSES as readonly string[]).includes(status)) throw new WooOpsError("invalid_order_status");
  return status as WooOrderStatus;
}

export interface RefundRequest {
  amount: string;
  reason?: string;
  /**
   * Whether WooCommerce should also call the payment gateway.
   *
   * Forced false, and not accepted from a caller. Refunding through a gateway
   * is irreversible and happens on someone else's money; this app's job is to
   * record that a refund was agreed, not to move funds. A store owner who
   * wants the card credited does that in WooCommerce, where the gateway's own
   * confirmation is visible.
   */
  apiRefund?: false;
}

export function sanitizeRefund(body: Record<string, unknown>): { amount: string; reason: string; api_refund: false } {
  const amount = String(body.amount ?? "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(amount) || Number(amount) <= 0) throw new WooOpsError("invalid_refund_amount");
  return {
    amount,
    reason: String(body.reason ?? "").trim().slice(0, 500),
    api_refund: false,
  };
}

/**
 * Enqueue one operation.
 *
 * Upserted on `(connection_id, entity_type, remote_id)` like every other
 * outbox row — pressing «ثبت» twice before the store is next reached
 * refreshes one job rather than queueing two.
 */
export async function enqueueOperation(
  businessId: string,
  connectionId: string,
  entityType: OpsEntityType,
  remoteId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const parentRemoteId =
    entityType === "product_update" ? await parentRemoteIdFor(businessId, connectionId, remoteId) : null;
  await query(
    `INSERT INTO integration_outbox_events (business_id, connection_id, entity_type, remote_id, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (connection_id, entity_type, remote_id)
     DO UPDATE SET payload = EXCLUDED.payload, status = 'pending', attempts = 0,
                   next_attempt_at = now(), last_error = NULL, leased_until = NULL, updated_at = now()`,
    [
      businessId,
      connectionId,
      entityType,
      remoteId,
      JSON.stringify(parentRemoteId ? { ...payload, __parentRemoteId: parentRemoteId } : payload),
    ],
  );
  await writeIntegrationAudit({
    businessId,
    connectionId,
    action: `outbox.${entityType}_queued`,
    entityType,
    remoteId,
    payload,
  });
}

/** Ask a plugin-connected store to (re)send what only it can see. */
export async function enqueueExport(
  businessId: string,
  connectionId: string,
  entityType: "catalogue_export" | "customer_export" | "orders_export",
  options: { sinceDays?: number } = {},
): Promise<void> {
  await query(
    `INSERT INTO integration_outbox_events (business_id, connection_id, entity_type, remote_id, payload)
     VALUES ($1, $2, $3, 'all', $4::jsonb)
     ON CONFLICT (connection_id, entity_type, remote_id)
     DO UPDATE SET payload = EXCLUDED.payload, status = 'pending', attempts = 0,
                   next_attempt_at = now(), last_error = NULL, leased_until = NULL, updated_at = now()`,
    [businessId, connectionId, entityType, JSON.stringify({ sinceDays: options.sinceDays ?? null })],
  );
}

// ---------------------------------------------------------------------------
// Reading the store's orders back
// ---------------------------------------------------------------------------

export interface StoreOrderRow {
  remoteId: string;
  localOrderId: string | null;
  localOrderNumber: number | null;
  number: string;
  status: string;
  total: string;
  currency: string;
  dateCreated: string | null;
  customer: string;
  paymentMethod: string;
  /** Whether the last delivery of this order applied cleanly. */
  ingestStatus: string;
  ingestError: string | null;
  lineCount: number;
}

/**
 * The orders this connection knows about, newest first.
 *
 * Read from the ingest inbox, not by calling the store: in plugin mode there
 * is no call to make, and in REST mode an extra round trip per screen would
 * put the store's latency into a dashboard. What the app already received is
 * also what it actually recorded — which is the question being asked.
 */
export async function storeOrdersFor(
  businessId: string,
  connectionId: string,
  limit = 50,
): Promise<StoreOrderRow[]> {
  const { rows } = await query<{
    remote_id: string;
    local_order_id: string | null;
    order_number: string | null;
    event_topic: string | null;
    payload: Record<string, unknown> | null;
    ingest_status: string | null;
    ingest_error: string | null;
    created_at: string;
  }>(
    `SELECT m.remote_id,
            m.local_id::text AS local_order_id,
            o.order_number::text,
            e.event_topic,
            e.payload,
            COALESCE(e.status, 'none') AS ingest_status,
            e.error AS ingest_error,
            e.created_at
       FROM integration_mappings m
       LEFT JOIN orders o ON o.id = m.local_id
       LEFT JOIN LATERAL (
         SELECT w.event_topic, w.payload, w.status, w.error, w.created_at
           FROM integration_webhook_events w
          WHERE w.connection_id = m.connection_id AND w.remote_id = m.remote_id
          ORDER BY w.created_at DESC
          LIMIT 1
       ) e ON true
      WHERE m.business_id = $1 AND m.connection_id = $2 AND m.entity_type = 'order'
      ORDER BY e.created_at DESC NULLS LAST, m.remote_id DESC
      LIMIT $3`,
    [businessId, connectionId, limit],
  );

  return rows.map((row) => {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const billing = (payload.billing ?? {}) as Record<string, unknown>;
    return {
      remoteId: row.remote_id,
      localOrderId: row.local_order_id,
      localOrderNumber: row.order_number === null ? null : Number(row.order_number),
      number: String(payload.number ?? row.remote_id),
      status: String(payload.status ?? ""),
      total: String(payload.total ?? "0"),
      currency: String(payload.currency ?? ""),
      dateCreated: typeof payload.date_created === "string" ? payload.date_created : null,
      customer: [billing.first_name, billing.last_name].filter(Boolean).join(" ").trim(),
      paymentMethod: String(payload.payment_method ?? ""),
      ingestStatus: row.ingest_status ?? "none",
      ingestError: row.ingest_error,
      lineCount: Array.isArray(payload.line_items) ? payload.line_items.length : 0,
    };
  });
}
