/**
 * Phase 40 — read models for the WordPress & WooCommerce Manager app.
 *
 * All queries here are local: they read what the sync has already mirrored
 * (mappings, terms, inbox events, content mirror, outbox queue). In plugin
 * mode that is the *only* data the app can have — it never dials the store —
 * so every manager screen works identically in both link modes.
 */
import { query } from "../db";
import { getConnection } from "./connections-service";
import { drainOutbox } from "./outbox-service";
import { applyIngestEvent } from "./webhook-ingest-service";
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
  localId?: string | null;
  error: string | null;
  attempts: number;
  nextAttemptAt?: string | null;
  sentAt?: string | null;
  processedAt?: string | null;
  deliveryId?: string | null;
  payload?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt?: string | null;
}

export interface WpQueueFilterOptions {
  status?: "open" | "pending" | "processing" | "failed" | "dead" | "sent" | "all";
  direction?: "all" | "out" | "in";
  search?: string;
  limit?: number;
}

export interface WpQueueSummary {
  total: number;
  pending: number;
  processing: number;
  failed: number;
  dead: number;
  sent: number;
  inboundFailed: number;
  outboundFailed: number;
}

/** The combined operational queue: outbound outbox jobs and inbound inbox failures. */
export async function wpQueue(
  businessId: string,
  connectionId: string,
  options?: WpQueueFilterOptions,
): Promise<WpQueueRow[]> {
  const statusFilter = options?.status ?? "open";
  const direction = options?.direction ?? "all";
  const search = options?.search?.trim() || "";
  const limit = Math.min(Math.max(1, options?.limit ?? 200), 500);

  const outboxParts: string[] = [
    "business_id = $1",
    "connection_id = $2",
    "connection_id IN (SELECT id FROM integration_connections WHERE business_id = $1 AND provider = 'woocommerce')",
  ];
  const inboxParts: string[] = [
    "business_id = $1",
    "connection_id = $2",
    "connection_id IN (SELECT id FROM integration_connections WHERE business_id = $1 AND provider = 'woocommerce')",
  ];

  if (statusFilter === "open") {
    outboxParts.push("status IN ('pending', 'failed', 'processing', 'dead')");
    inboxParts.push("status IN ('failed', 'pending')");
  } else if (statusFilter === "pending") {
    outboxParts.push("status IN ('pending', 'processing')");
    inboxParts.push("status = 'pending'");
  } else if (statusFilter === "processing") {
    outboxParts.push("status = 'processing'");
    inboxParts.push("1=0");
  } else if (statusFilter === "failed") {
    outboxParts.push("status IN ('failed', 'dead')");
    inboxParts.push("status = 'failed'");
  } else if (statusFilter === "dead") {
    outboxParts.push("status = 'dead'");
    inboxParts.push("1=0");
  } else if (statusFilter === "sent") {
    outboxParts.push("status = 'sent'");
    inboxParts.push("status = 'processed'");
  }
  // statusFilter === 'all' adds no extra status constraint

  const params: unknown[] = [businessId, connectionId];
  if (search) {
    params.push(`%${search}%`);
    const searchIdx = `$${params.length}`;
    outboxParts.push(`(remote_id ILIKE ${searchIdx} OR entity_type ILIKE ${searchIdx} OR last_error ILIKE ${searchIdx})`);
    inboxParts.push(`(remote_id ILIKE ${searchIdx} OR event_topic ILIKE ${searchIdx} OR error ILIKE ${searchIdx})`);
  }

  const outboxSql = `
    SELECT id::text, 'out' AS direction, entity_type AS kind, status, remote_id, local_id::text,
           last_error AS error, attempts, next_attempt_at::text, sent_at::text,
           NULL::text AS processed_at, NULL::text AS delivery_id, payload,
           created_at::text, updated_at::text
      FROM integration_outbox_events
     WHERE ${outboxParts.join(" AND ")}
  `;

  const inboxSql = `
    SELECT id::text, 'in' AS direction, event_topic AS kind, status, remote_id, NULL::text AS local_id,
           error, 0 AS attempts, NULL::text AS next_attempt_at, NULL::text AS sent_at,
           processed_at::text, delivery_id, payload,
           created_at::text, created_at::text AS updated_at
      FROM integration_webhook_events
     WHERE ${inboxParts.join(" AND ")}
  `;

  let combinedSql: string;
  if (direction === "out") {
    combinedSql = `${outboxSql} ORDER BY created_at DESC LIMIT ${limit}`;
  } else if (direction === "in") {
    combinedSql = `${inboxSql} ORDER BY created_at DESC LIMIT ${limit}`;
  } else {
    combinedSql = `(${outboxSql}) UNION ALL (${inboxSql}) ORDER BY created_at DESC LIMIT ${limit}`;
  }

  const { rows } = await query<{
    id: string;
    direction: string;
    kind: string;
    status: string;
    remote_id: string;
    local_id: string | null;
    error: string | null;
    attempts: number;
    next_attempt_at: string | null;
    sent_at: string | null;
    processed_at: string | null;
    delivery_id: string | null;
    payload: Record<string, unknown> | null;
    created_at: string;
    updated_at: string | null;
  }>(combinedSql, params);

  return rows.map((r) => ({
    id: r.id,
    direction: r.direction as "out" | "in",
    kind: r.kind,
    status: r.status,
    remoteId: r.remote_id,
    localId: r.local_id,
    error: r.error,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    sentAt: r.sent_at,
    processedAt: r.processed_at,
    deliveryId: r.delivery_id,
    payload: r.payload,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

/** Aggregate counts of outbox & inbox events for the queue dashboard. */
export async function wpQueueSummary(businessId: string, connectionId: string): Promise<WpQueueSummary> {
  const [outboxRes, inboxRes] = await Promise.all([
    query<{ status: string; n: string }>(
      `SELECT status, count(*)::text AS n FROM integration_outbox_events
        WHERE business_id = $1 AND connection_id = $2
        GROUP BY status`,
      [businessId, connectionId],
    ),
    query<{ status: string; n: string }>(
      `SELECT status, count(*)::text AS n FROM integration_webhook_events
        WHERE business_id = $1 AND connection_id = $2
        GROUP BY status`,
      [businessId, connectionId],
    ),
  ]);

  const outbox = new Map(outboxRes.rows.map((r) => [r.status, Number(r.n)]));
  const inbox = new Map(inboxRes.rows.map((r) => [r.status, Number(r.n)]));

  const pending = (outbox.get("pending") ?? 0) + (inbox.get("pending") ?? 0);
  const processing = outbox.get("processing") ?? 0;
  const failed = (outbox.get("failed") ?? 0) + (inbox.get("failed") ?? 0);
  const dead = outbox.get("dead") ?? 0;
  const sent = (outbox.get("sent") ?? 0) + (inbox.get("processed") ?? 0);
  const outboundFailed = (outbox.get("failed") ?? 0) + (outbox.get("dead") ?? 0);
  const inboundFailed = inbox.get("failed") ?? 0;
  const total =
    Array.from(outbox.values()).reduce((a, b) => a + b, 0) +
    Array.from(inbox.values()).reduce((a, b) => a + b, 0);

  return {
    total,
    pending,
    processing,
    failed,
    dead,
    sent,
    inboundFailed,
    outboundFailed,
  };
}

/** Retry a single queue row (either outbound outbox or inbound webhook). */
export async function retryWpQueueRow(
  businessId: string,
  connectionId: string,
  rowId: string,
  direction?: "out" | "in",
): Promise<{ ok: boolean; error?: string; status?: string }> {
  // If direction is "out" or not specified, try outbox first
  if (direction !== "in") {
    const { rows: outboxRows } = await query<{ id: string }>(
      `SELECT id FROM integration_outbox_events
        WHERE id = $1 AND business_id = $2 AND connection_id = $3`,
      [rowId, businessId, connectionId],
    );
    if (outboxRows.length > 0) {
      await query(
        `UPDATE integration_outbox_events
            SET status = 'pending',
                attempts = 0,
                next_attempt_at = now(),
                last_error = NULL,
                leased_until = NULL,
                updated_at = now()
          WHERE id = $1 AND business_id = $2 AND connection_id = $3`,
        [rowId, businessId, connectionId],
      );

      const connection = await getConnection(businessId, connectionId);
      if (connection && connection.status === "active" && connection.link_mode === "rest_api") {
        try {
          await drainOutbox(connection);
        } catch {
          // Ignored — background worker will pick it up
        }
      }
      return { ok: true, status: "pending" };
    }
  }

  // If not found in outbox or direction is "in", try webhook events (inbox)
  const { rows: inboxRows } = await query<{
    id: string;
    event_topic: string;
    remote_id: string;
    delivery_id: string;
    payload: unknown;
  }>(
    `SELECT id, event_topic, remote_id, delivery_id, payload
       FROM integration_webhook_events
      WHERE id = $1 AND business_id = $2 AND connection_id = $3`,
    [rowId, businessId, connectionId],
  );

  if (inboxRows.length > 0) {
    const row = inboxRows[0];
    const connection = await getConnection(businessId, connectionId);
    if (!connection) return { ok: false, error: "connection_not_found" };

    await query(
      `UPDATE integration_webhook_events
          SET status = 'pending', error = NULL, processed_at = NULL
        WHERE id = $1`,
      [row.id],
    );

    try {
      const outcome = await applyIngestEvent(connection, {
        topic: row.event_topic,
        deliveryId: row.delivery_id,
        payload: (row.payload ?? {}) as Record<string, unknown>,
      });
      return { ok: outcome.status !== "failed", status: outcome.status, error: "error" in outcome ? outcome.error : undefined };
    } catch (err) {
      const message = (err as Error).message;
      await query(`UPDATE integration_webhook_events SET status = 'failed', error = $2 WHERE id = $1`, [row.id, message]);
      return { ok: false, status: "failed", error: message };
    }
  }

  return { ok: false, error: "not_found" };
}

/** Retry all failed and dead events for a connection. */
export async function retryAllFailedWpQueue(
  businessId: string,
  connectionId: string,
): Promise<{ ok: boolean; outboxRetried: number; inboxRetried: number }> {
  // 1. Reset all failed / dead outbox events
  const { rowCount: outboxCount } = await query(
    `UPDATE integration_outbox_events
        SET status = 'pending',
            attempts = 0,
            next_attempt_at = now(),
            last_error = NULL,
            leased_until = NULL,
            updated_at = now()
      WHERE business_id = $1 AND connection_id = $2 AND status IN ('failed', 'dead')`,
    [businessId, connectionId],
  );

  // 2. Fetch failed inbox events and re-process them
  const { rows: failedInbox } = await query<{ id: string; event_topic: string; delivery_id: string; payload: unknown }>(
    `SELECT id, event_topic, delivery_id, payload
       FROM integration_webhook_events
      WHERE business_id = $1 AND connection_id = $2 AND status = 'failed'`,
    [businessId, connectionId],
  );

  const connection = await getConnection(businessId, connectionId);
  let inboxRetried = 0;
  if (connection) {
    for (const item of failedInbox) {
      await query(
        `UPDATE integration_webhook_events
            SET status = 'pending', error = NULL, processed_at = NULL
          WHERE id = $1`,
        [item.id],
      );
      try {
        await applyIngestEvent(connection, {
          topic: item.event_topic,
          deliveryId: item.delivery_id,
          payload: (item.payload ?? {}) as Record<string, unknown>,
        });
        inboxRetried++;
      } catch (err) {
        await query(`UPDATE integration_webhook_events SET status = 'failed', error = $2 WHERE id = $1`, [item.id, (err as Error).message]);
      }
    }

    if (connection.status === "active" && connection.link_mode === "rest_api" && (outboxCount ?? 0) > 0) {
      try {
        await drainOutbox(connection);
      } catch {
        // Ignored
      }
    }
  }

  return { ok: true, outboxRetried: outboxCount ?? 0, inboxRetried };
}

/** Flush outbox queue for connection. */
export async function flushWpOutbox(
  businessId: string,
  connectionId: string,
): Promise<{ ok: boolean; mode: "rest_api" | "plugin"; drained?: number; message?: string }> {
  const connection = await getConnection(businessId, connectionId);
  if (!connection || connection.provider !== "woocommerce") {
    return { ok: false, mode: "rest_api", message: "فروشگاه یافت نشد" };
  }

  if (connection.link_mode === "rest_api") {
    await drainOutbox(connection);
    return { ok: true, mode: "rest_api", message: "صف خروجی به فروشگاه ارسال شد." };
  } else {
    return {
      ok: true,
      mode: "plugin",
      message: "در حالت افزونه، کارهای در انتظار در درخواست دوره‌ای بعدی افزونه دریافت و اعمال می‌شوند.",
    };
  }
}
