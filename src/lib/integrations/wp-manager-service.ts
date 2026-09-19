/**
 * Phase 40 — read models for the WordPress & WooCommerce Manager app.
 *
 * All queries here are local: they read what the sync has already mirrored
 * (mappings, terms, inbox events, content mirror, outbox queue). In plugin
 * mode that is the *only* data the app can have — it never dials the store —
 * so every manager screen works identically in both link modes.
 */
import { query } from "../db";
import { wpContentCounts } from "./wp-content-service";

export interface WpOverviewStats {
  connections: {
    total: number;
    active: number;
    plugin: number;
    rest: number;
  };
  products: number;
  orders: number;
  customers: number;
  terms: number;
  content: { posts: number; pages: number; media: number };
  pendingJobs: number;
  failedJobs: number;
  deadJobs: number;
  pendingInboxEvents: number;
  failedInboxEvents: number;
}

/** Aggregate counts for the manager's میز کار, scoped to one connection or the whole business. */
export async function wpOverviewStats(
  businessId: string,
  connectionId?: string | null,
): Promise<WpOverviewStats> {
  const scope = connectionId ? "AND id = $2" : "";
  const params: unknown[] = connectionId ? [businessId, connectionId] : [businessId];

  const { rows: connRows } = await query<{ total: string; active: string; plugin: string; rest: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE status = 'active')::text AS active,
            count(*) FILTER (WHERE link_mode = 'plugin')::text AS plugin,
            count(*) FILTER (WHERE link_mode = 'rest_api')::text AS rest
       FROM integration_connections
      WHERE business_id = $1 AND provider = 'woocommerce' ${scope}`,
    params,
  );

  const conn = connRows[0] ?? { total: "0", active: "0", plugin: "0", rest: "0" };

  const { rows: mapRows } = await query<{ entity: string; n: string }>(
    `SELECT entity_type AS entity, count(DISTINCT remote_id)::text AS n
       FROM integration_mappings
      WHERE business_id = $1
        AND connection_id IN (SELECT id FROM integration_connections WHERE business_id = $1 AND provider = 'woocommerce')
        ${connectionId ? "AND connection_id = $2" : ""}
        AND entity_type IN ('product', 'order', 'customer', 'refund')
      GROUP BY entity_type`,
    connectionId ? [businessId, connectionId] : [businessId],
  );
  const byEntity = new Map(mapRows.map((r) => [r.entity, Number(r.n)]));

  const { rows: termRows } = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM integration_woo_terms
      WHERE business_id = $1
        AND connection_id IN (SELECT id FROM integration_connections WHERE business_id = $1 AND provider = 'woocommerce')
        ${connectionId ? "AND connection_id = $2" : ""}`,
    connectionId ? [businessId, connectionId] : [businessId],
  );

  // Content counts mirror one connection per row; across a business with
  // several stores they sum, which is what the overview wants to show.
  const contentTotaled = connectionId
    ? await wpContentCounts(businessId, connectionId)
    : (
        await query<{ wp_type: string; n: string }>(
          `SELECT wp_type, count(*)::text AS n
             FROM integration_wp_content
            WHERE business_id = $1
              AND connection_id IN (SELECT id FROM integration_connections WHERE business_id = $1 AND provider = 'woocommerce')
            GROUP BY wp_type`,
          [businessId],
        )
      ).rows.reduce(
        (acc, r) => {
          if (r.wp_type === "post") acc.posts = Number(r.n);
          else if (r.wp_type === "page") acc.pages = Number(r.n);
          else if (r.wp_type === "attachment") acc.media = Number(r.n);
          return acc;
        },
        { posts: 0, pages: 0, media: 0 },
      );

  const { rows: outboxRows } = await query<{ status: string; n: string }>(
    `SELECT status, count(*)::text AS n FROM integration_outbox_events
      WHERE business_id = $1
        AND connection_id IN (SELECT id FROM integration_connections WHERE business_id = $1 AND provider = 'woocommerce')
        ${connectionId ? "AND connection_id = $2" : ""}
      GROUP BY status`,
    connectionId ? [businessId, connectionId] : [businessId],
  );
  const outbox = new Map(outboxRows.map((r) => [r.status, Number(r.n)]));

  const { rows: inboxRows } = await query<{ status: string; n: string }>(
    `SELECT status, count(*)::text AS n FROM integration_webhook_events
      WHERE business_id = $1
        AND connection_id IN (SELECT id FROM integration_connections WHERE business_id = $1 AND provider = 'woocommerce')
        ${connectionId ? "AND connection_id = $2" : ""}
        AND status IN ('pending', 'failed')
      GROUP BY status`,
    connectionId ? [businessId, connectionId] : [businessId],
  );
  const inbox = new Map(inboxRows.map((r) => [r.status, Number(r.n)]));

  return {
    connections: {
      total: Number(conn.total),
      active: Number(conn.active),
      plugin: Number(conn.plugin),
      rest: Number(conn.rest),
    },
    products: byEntity.get("product") ?? 0,
    orders: byEntity.get("order") ?? 0,
    customers: byEntity.get("customer") ?? 0,
    terms: Number(termRows[0]?.n ?? 0),
    content: contentTotaled,
    pendingJobs: (outbox.get("pending") ?? 0) + (outbox.get("processing") ?? 0) + (outbox.get("failed") ?? 0),
    failedJobs: outbox.get("failed") ?? 0,
    deadJobs: outbox.get("dead") ?? 0,
    pendingInboxEvents: inbox.get("pending") ?? 0,
    failedInboxEvents: inbox.get("failed") ?? 0,
  };
}

export interface WpStoreCustomerRow {
  remoteId: string;
  localId: string;
  name: string;
  phone: string | null;
  email: string | null;
  ordersCount: number;
  lastSeen: string | null;
}

export interface WpStoreCustomersPage {
  customers: WpStoreCustomerRow[];
  /** All matched mappings, including the ones past the returned page. */
  total: number;
}

/**
 * The store's customers as the app knows them: mapping joined to the local
 * customer record, with the count of orders mirrored *from this store*.
 *
 * The order count deliberately goes through the order mappings — not
 * `orders.customer_id` alone — because the same CRM party also buys at the
 * POS, and the badge this feeds is labeled «سفارش آنلاین». `last_seen`
 * falls back to the mapping's own update time: a store that only ever
 * pull-syncs (REST scheduled pulls, plugin exports) has no `customer.*`
 * inbox events, and without the fallback the column was blank for exactly
 * those stores. The page is capped at 500 rows; `total` is the *full*
 * matched count so the UI can say «نمایش ۵۰۰ نخست از N» instead of
 * silently implying 500 customers is everyone.
 */
export async function wpStoreCustomers(
  businessId: string,
  connectionId: string,
): Promise<WpStoreCustomersPage> {
  const { rows } = await query<{
    remote_id: string;
    local_id: string;
    name: string;
    phone: string | null;
    email: string | null;
    orders_count: string;
    last_seen: string | null;
    total_count: string;
  }>(
    `SELECT m.remote_id, m.local_id::text,
            COALESCE(c.name, '') AS name,
            c.phone, c.email,
            (SELECT count(*)
               FROM integration_mappings om
               JOIN orders o ON o.id = om.local_id
              WHERE om.business_id = $1
                AND om.connection_id = m.connection_id
                AND om.entity_type = 'order'
                AND o.customer_id = m.local_id)::text AS orders_count,
            COALESCE(
              (SELECT max(w.created_at)
                 FROM integration_webhook_events w
                WHERE w.connection_id = m.connection_id
                  AND w.event_topic LIKE 'customer.%'
                  AND w.remote_id = m.remote_id),
              m.updated_at
            )::text AS last_seen,
            count(*) OVER ()::text AS total_count
       FROM integration_mappings m
       LEFT JOIN parties c ON c.id = m.local_id
      WHERE m.business_id = $1 AND m.connection_id = $2
        AND m.connection_id IN (SELECT id FROM integration_connections WHERE business_id = $1 AND provider = 'woocommerce')
        AND m.entity_type = 'customer'
      ORDER BY name, m.remote_id
      LIMIT 500`,
    [businessId, connectionId],
  );
  return {
    customers: rows.map((r) => ({
      remoteId: r.remote_id,
      localId: r.local_id,
      name: r.name,
      phone: r.phone,
      email: r.email,
      ordersCount: Number(r.orders_count),
      lastSeen: r.last_seen,
    })),
    total: Number(rows[0]?.total_count ?? 0),
  };
}

export interface WpQueueRow {
  id: string;
  direction: "out" | "in";
  kind: string;
  status: string;
  remoteId: string;
  error: string | null;
  attempts: number;
  createdAt: string;
}

/** The combined operational queue: outbound outbox jobs and inbound inbox failures. */
export async function wpQueue(businessId: string, connectionId: string): Promise<WpQueueRow[]> {
  const { rows } = await query<{
    id: string;
    direction: string;
    kind: string;
    status: string;
    remote_id: string;
    error: string | null;
    attempts: number;
    created_at: string;
  }>(
    `SELECT id::text, 'out' AS direction, entity_type AS kind, status, remote_id,
            last_error AS error, attempts, created_at::text
       FROM integration_outbox_events
      WHERE business_id = $1 AND connection_id = $2
        AND connection_id IN (SELECT id FROM integration_connections WHERE business_id = $1 AND provider = 'woocommerce')
        AND status IN ('pending', 'failed', 'processing', 'dead')
    UNION ALL
    SELECT id::text, 'in' AS direction, event_topic AS kind, status, remote_id,
            error, 0 AS attempts, created_at::text
       FROM integration_webhook_events
      WHERE business_id = $1 AND connection_id = $2
        AND connection_id IN (SELECT id FROM integration_connections WHERE business_id = $1 AND provider = 'woocommerce')
        AND status IN ('failed', 'pending')
    ORDER BY created_at DESC
      LIMIT 200`,
    [businessId, connectionId],
  );
  return rows.map((r) => ({
    id: r.id,
    direction: r.direction as "out" | "in",
    kind: r.kind,
    status: r.status,
    remoteId: r.remote_id,
    error: r.error,
    attempts: r.attempts,
    createdAt: r.created_at,
  }));
}
