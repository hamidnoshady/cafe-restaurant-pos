/**
 * Phase 23 (issue #118) — Wave 2 (orders) and Wave 5 (refunds): inbound
 * WooCommerce webhooks become local orders/payments and balanced journal
 * entries. DB-touching (not unit-tested directly; the signature verification
 * and money conversion it leans on are covered by their own tests).
 *
 * Idempotency has two layers: the inbox's UNIQUE (connection_id, delivery_id)
 * dedups a replayed delivery, and integration_mappings' UNIQUE
 * (connection_id, entity_type, remote_id) means an `order.updated`/`restored`
 * that arrives after `order.created` is a no-op at the order level too.
 */
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getPool, query, withoutTenantScope, withTenant } from "../db";
import { WELL_KNOWN_CODES } from "../coa-template";
import { accountIdsByCode, postExactCogsEntry, postExactJournalEntry } from "../ledger-service";
import { deductForOrder } from "../inventory-service";
import { createCustomerReturn, type ReturnLine } from "../customer-return-service";
import { quantityText, type RialText } from "../inventory-exact";
import { getPrimaryLocation } from "../setup-state";
import {
  CONNECTION_COLUMNS,
  webhookSecretFor,
  type ConnectionRow,
} from "./connections-service";
import {
  WOO_DELIVERY_ID_HEADER,
  WOO_SIGNATURE_HEADER,
  verifyWooWebhookSignature,
} from "./webhook-signature";
import { wooAmountToRial } from "./woo-money";
import { writeIntegrationAudit } from "./audit";
import { connectionLocationId, upsertCustomerFromWoo, upsertProductFromWoo } from "./sync-service";
import type { WooCustomer, WooOrder, WooProduct, WooRefund } from "./woocommerce-client";

const zero = "0" as RialText;

export async function handleWooCommerceWebhook(
  connectionId: string,
  rawBody: string,
  headers: Headers,
): Promise<NextResponse> {
  // Identify the tenant from the connection id in the URL, before any tenant
  // scope exists — the documented woocommerce-webhook-auth bypass.
  const connection = await withoutTenantScope("woocommerce-webhook-auth", async () => {
    const { rows } = await query<ConnectionRow>(
      `SELECT ${CONNECTION_COLUMNS} FROM integration_connections WHERE id = $1`,
      [connectionId],
    );
    return rows[0] ?? null;
  });
  if (!connection) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (!verifyWooWebhookSignature(rawBody, headers.get(WOO_SIGNATURE_HEADER), webhookSecretFor(connection))) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  const topic = headers.get("x-wc-webhook-topic") ?? "";
  const deliveryId = headers.get(WOO_DELIVERY_ID_HEADER) ?? `manual-${randomUUID()}`;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  return withTenant(connection.business_id, () =>
    processWebhookEvent(connection, { topic, deliveryId, payload }),
  );
}

interface WebhookEvent {
  topic: string;
  deliveryId: string;
  payload: Record<string, unknown>;
}

/** What one event did, in the form both doors report it. */
type IngestOutcome =
  | { status: "processed" }
  | { status: "duplicate" }
  | { status: "failed"; error: string };

/**
 * The single ingest path, shared by both ways a store reaches this app: a
 * WooCommerce webhook delivery (authenticated by its HMAC) and a WordPress
 * plugin push (authenticated by its signed envelope). Everything either one
 * produces — the inbox row, the dedup, the order, the payment, the journal
 * entry — comes from here, so the two doors cannot drift into recording a sale
 * two different ways.
 *
 * Idempotency has two layers: the inbox's UNIQUE (connection_id, delivery_id)
 * dedups a replayed delivery, and integration_mappings' UNIQUE
 * (connection_id, entity_type, remote_id) means an `order.updated`/`restored`
 * that arrives after `order.created` is a no-op at the order level too.
 */
async function applyIngestEvent(connection: ConnectionRow, event: WebhookEvent): Promise<IngestOutcome> {
  const businessId = connection.business_id;
  const remoteId = event.payload?.id != null ? String(event.payload.id) : "";

  const { rows: inserted } = await query<{ id: string }>(
    `INSERT INTO integration_webhook_events
       (business_id, connection_id, event_topic, remote_id, delivery_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (connection_id, delivery_id) DO NOTHING
     RETURNING id`,
    [businessId, connection.id, event.topic, remoteId, event.deliveryId, JSON.stringify(event.payload)],
  );

  if (inserted.length === 0) {
    await query(
      `UPDATE integration_webhook_events SET status = 'duplicate', processed_at = now()
        WHERE connection_id = $1 AND delivery_id = $2`,
      [connection.id, event.deliveryId],
    );
    return { status: "duplicate" };
  }
  const inboxId = inserted[0].id;

  try {
    if (event.topic.endsWith("order.created") || event.topic.endsWith("order.updated") || event.topic.endsWith("order.restored")) {
      if (connection.sync_orders) {
        await ingestOrder(connection, event.payload as unknown as WooOrder);
      }
    } else if (event.topic.endsWith("refund.created")) {
      await ingestRefund(connection, event.payload as unknown as WooRefund, inboxId);
    } else if (event.topic.endsWith("product.created") || event.topic.endsWith("product.updated")) {
      // In REST mode a product event is only a hint — the app pulls the
      // catalogue itself — but a plugin push is the *only* way the catalogue
      // ever arrives, so it is applied here for both. Applying it twice is
      // harmless: upsertProductFromWoo is keyed on the mapping row.
      if (connection.sync_products) {
        await upsertProductFromWoo(
          connection,
          await connectionLocationId(connection),
          event.payload as unknown as WooProduct,
        );
      }
    } else if (event.topic.endsWith("customer.created") || event.topic.endsWith("customer.updated")) {
      if (connection.sync_customers) {
        await upsertCustomerFromWoo(connection, event.payload as unknown as WooCustomer);
      }
    }
    // Any other topic is acknowledged and left alone — we never want a
    // re-delivery storm for an event we don't handle yet.
    await query(`UPDATE integration_webhook_events SET status = 'processed', processed_at = now() WHERE id = $1`, [inboxId]);
    return { status: "processed" };
  } catch (err) {
    const message = (err as Error).message;
    await query(`UPDATE integration_webhook_events SET status = 'failed', error = $2 WHERE id = $1`, [inboxId, message]);
    return { status: "failed", error: message };
  }
}

async function processWebhookEvent(connection: ConnectionRow, event: WebhookEvent): Promise<NextResponse> {
  const outcome = await applyIngestEvent(connection, event);
  if (outcome.status === "duplicate") return NextResponse.json({ ok: true, duplicate: true }, { status: 200 });
  if (outcome.status === "failed") return NextResponse.json({ ok: false, error: outcome.error }, { status: 500 });
  return NextResponse.json({ ok: true }, { status: 200 });
}

/** One event as the WordPress plugin sends it. */
export interface PluginEventInput {
  topic?: string;
  /** The plugin's own idempotency key, generated once per event and reused across retries. */
  deliveryId?: string;
  payload?: Record<string, unknown>;
}

/**
 * Apply one plugin-pushed event and report what happened to *that* event.
 *
 * Unlike a webhook, a plugin push is a batch: the caller needs a per-event
 * answer so one malformed order does not force it to re-send ninety-nine good
 * ones. A failure is reported, not thrown, for the same reason — the batch
 * continues, and the plugin re-sends only what failed.
 *
 * Must be called inside the connection's tenant scope; plugin-service.ts's
 * `pluginPushEvents` establishes it once for the whole batch.
 */
export async function ingestPluginEvent(
  connection: ConnectionRow,
  event: PluginEventInput,
): Promise<{ deliveryId: string; status: string; error?: string }> {
  const deliveryId = event.deliveryId?.trim() || `plugin-${randomUUID()}`;
  const topic = event.topic?.trim() ?? "";
  if (!topic) return { deliveryId, status: "failed", error: "missing_topic" };
  if (!event.payload || typeof event.payload !== "object") {
    return { deliveryId, status: "failed", error: "missing_payload" };
  }

  const outcome = await applyIngestEvent(connection, { topic, deliveryId, payload: event.payload });
  return outcome.status === "failed"
    ? { deliveryId, status: "failed", error: outcome.error }
    : { deliveryId, status: outcome.status };
}

/** The branch an integration writes to: the connection's own, else the primary. */
async function resolveLocationId(connection: ConnectionRow): Promise<string> {
  if (connection.location_id) return connection.location_id;
  const primary = await getPrimaryLocation(connection.business_id);
  if (!primary) throw new Error("no_location");
  return primary.id;
}

async function ingestOrder(connection: ConnectionRow, order: WooOrder): Promise<void> {
  const businessId = connection.business_id;
  const remoteId = String(order.id);

  const total = wooAmountToRial(order.total ?? "0", connection.currency_unit);
  const tax = wooAmountToRial(order.total_tax ?? "0", connection.currency_unit);
  if (tax > total) throw new Error("tax_exceeds_total");
  const net = total - tax;

  const locationId = await resolveLocationId(connection);
  const note = order.billing
    ? `مشتری: ${[order.billing.first_name, order.billing.last_name].filter(Boolean).join(" ")}`
    : null;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Serialize concurrent deliveries of the same remote order: two different
    // webhook deliveries (order.created + order.updated) can race, and the
    // advisory lock plus the in-transaction mapping re-check makes the second
    // a no-op rather than a duplicate order.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`woo-order:${connection.id}:${remoteId}`]);
    const { rows: mapped } = await client.query(
      `SELECT 1 FROM integration_mappings
        WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'order' AND remote_id = $3`,
      [businessId, connection.id, remoteId],
    );
    if (mapped.length > 0) {
      await client.query("ROLLBACK");
      return;
    }

    const { rows: counter } = await client.query<{ next_number: string }>(
      `INSERT INTO order_number_counters (location_id, next_number) VALUES ($1, 2)
       ON CONFLICT (location_id) DO UPDATE SET next_number = order_number_counters.next_number + 1
       RETURNING next_number - 1 AS next_number`,
      [locationId],
    );
    const orderNumber = Number(counter[0].next_number);

    // Insert as 'open' first — the order_items financial guard (migration
    // 0014) rejects item inserts against a non-open order. The order is
    // closed to 'completed' below, after items and payment are recorded,
    // mirroring the POS checkout flow.
    const { rows: orderRows } = await client.query<{ id: string }>(
      `INSERT INTO orders (location_id, order_number, type, status, subtotal, discount, service_charge, tax, total, note)
       VALUES ($1, $2, 'delivery', 'open', $3, 0, 0, $4, $5, $6)
       RETURNING id`,
      [locationId, orderNumber, net.toString(), tax.toString(), total.toString(), note],
    );
    const orderId = orderRows[0].id;

    // Resolve each line's WooCommerce product to its mapped local menu item
    // (Wave 3's integration_mappings) so recipe-based inventory deducts for
    // online sales exactly like a POS sale. Unmapped lines are still recorded
    // — revenue is never missed — but contribute no stock movement, the POS
    // equivalent of an order item with no recipe.
    const remoteProductIds = (order.line_items ?? [])
      .map((line) => String(line.product_id))
      .filter((id): id is string => Boolean(id));
    const menuItemByRemote = new Map<string, string>();
    if (remoteProductIds.length > 0) {
      const { rows: productMappings } = await client.query<{ remote_id: string; local_id: string }>(
        `SELECT remote_id, local_id FROM integration_mappings
          WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'product'
            AND remote_id = ANY($3::text[])`,
        [businessId, connection.id, remoteProductIds],
      );
      for (const m of productMappings) menuItemByRemote.set(m.remote_id, m.local_id);
    }

    for (const line of order.line_items ?? []) {
      const unitPrice = wooAmountToRial(line.price ?? "0", connection.currency_unit);
      const quantity = Math.max(1, Math.round(line.quantity ?? 1));
      const menuItemId = menuItemByRemote.get(String(line.product_id)) ?? null;
      await client.query(
        `INSERT INTO order_items (location_id, order_id, menu_item_id, name_snapshot, unit_price, quantity, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'served')`,
        [locationId, orderId, menuItemId, line.name, unitPrice.toString(), quantity],
      );
    }

    if (total > 0n) {
      await client.query(
        `INSERT INTO payments (location_id, order_id, method, amount, reference)
         VALUES ($1, $2, 'online', $3, $4)`,
        [locationId, orderId, total.toString(), order.number ?? remoteId],
      );
    }

    const { rowCount: closed } = await client.query(
      `UPDATE orders SET status = 'completed', closed_at = now()
        WHERE id = $1 AND status = 'open'
        RETURNING id`,
      [orderId],
    );
    if (closed !== 1) {
      throw new Error("order_close_failed");
    }

    // Inventory + COGS for the mapped lines — the identical flow the POS pay
    // route runs: one sale_consumption inventory event, recipe-based
    // deduction through the shared inventory service, and the same COGS
    // journal entry (Debit COGS / Credit Inventory), all in this transaction.
    // Orders with no mapped products post no COGS (their cost basis doesn't
    // exist yet), the same shape as a POS item with no recipe.
    let inventoryEventId: string | null = null;
    let cogsRial = "0";
    if (menuItemByRemote.size > 0) {
      const { rows: eventRows } = await client.query<{ id: string }>(
        `INSERT INTO inventory_events
           (business_id, location_id, event_type, source_type, source_id, created_by, idempotency_key, costing_version)
         VALUES ($1, $2, 'sale_consumption', 'order', $3, NULL, $4, 2)
         RETURNING id`,
        [businessId, locationId, orderId, `woo-order:${orderId}`],
      );
      inventoryEventId = eventRows[0].id;
      const { totalCost } = await deductForOrder(client, businessId, locationId, orderId, null, inventoryEventId);
      cogsRial = totalCost;
      await postExactCogsEntry(client, {
        businessId,
        locationId,
        orderId,
        createdBy: null,
        totalCost,
        inventoryEventId,
      });
    }

    const accounts = await accountIdsByCode(client, businessId, [
      WELL_KNOWN_CODES.bankClearing,
      WELL_KNOWN_CODES.deliveryRevenue,
      WELL_KNOWN_CODES.vatPayable,
    ]);
    await postExactJournalEntry(client, {
      businessId,
      locationId,
      memo: `فروش آنلاین ووکامرس #${order.number ?? order.id}`,
      sourceType: "woocommerce_order",
      sourceId: orderId,
      createdBy: null,
      postingKind: "revenue",
      inventoryEventId,
      lines: [
        { accountId: accounts.get(WELL_KNOWN_CODES.bankClearing)!, debit: total.toString() as RialText, credit: zero },
        { accountId: accounts.get(WELL_KNOWN_CODES.deliveryRevenue)!, debit: zero, credit: net.toString() as RialText },
        ...(tax > 0n
          ? [{ accountId: accounts.get(WELL_KNOWN_CODES.vatPayable)!, debit: zero, credit: tax.toString() as RialText }]
          : []),
      ],
    });
    if (inventoryEventId) {
      await client.query("UPDATE inventory_events SET posting_status='posted' WHERE id=$1", [inventoryEventId]);
    }

    await client.query(
      `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
       VALUES ($1, $2, 'order', $3, $4)
       ON CONFLICT (connection_id, entity_type, remote_id) DO NOTHING`,
      [businessId, connection.id, remoteId, orderId],
    );
    await client.query("COMMIT");

    await writeIntegrationAudit({
      businessId,
      connectionId: connection.id,
      action: "order.imported",
      entityType: "order",
      remoteId,
      localId: orderId,
      payload: { orderNumber: order.number ?? remoteId, totalRial: total.toString(), cogsRial },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Maps a WooCommerce refund's line items to local order items via the product
 * mapping, splitting a quantity across repeated rows of the same product and
 * never exceeding what each order item still has returnable. Unmapped products
 * are skipped — an order line that never deducted inventory has nothing to
 * restore.
 */
async function buildRefundReturnLines(
  client: import("pg").PoolClient,
  businessId: string,
  connection: ConnectionRow,
  orderId: string,
  refund: WooRefund,
): Promise<ReturnLine[]> {
  const lines: ReturnLine[] = [];
  const remoteProductIds = (refund.line_items ?? [])
    .map((line) => String(line.product_id))
    .filter((id): id is string => Boolean(id));
  if (remoteProductIds.length === 0) return lines;
  const { rows: productMappings } = await client.query<{ remote_id: string; local_id: string }>(
    `SELECT remote_id, local_id FROM integration_mappings
      WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'product'
        AND remote_id = ANY($3::text[])`,
    [businessId, connection.id, remoteProductIds],
  );
  const menuItemByRemote = new Map(productMappings.map((m) => [m.remote_id, m.local_id]));

  for (const line of refund.line_items ?? []) {
    const menuItemId = menuItemByRemote.get(String(line.product_id));
    if (!menuItemId) continue;
    // WooCommerce refund quantities are negative.
    let remaining = Math.max(0, Math.abs(Math.round(line.quantity ?? 0)));
    if (remaining === 0) continue;
    const { rows: items } = await client.query<{ id: string; quantity: string; returned: string }>(
      `SELECT oi.id, oi.quantity::text,
              COALESCE((SELECT sum(l.quantity)::text FROM customer_return_lines l
                         WHERE l.order_item_id = oi.id), '0') AS returned
         FROM order_items oi
        WHERE oi.order_id = $1 AND oi.menu_item_id = $2 AND oi.status <> 'voided'
        ORDER BY oi.created_at, oi.id`,
      [orderId, menuItemId],
    );
    for (const item of items) {
      if (remaining <= 0) break;
      const take = Math.min(Number(item.quantity) - Number(item.returned), remaining);
      if (take > 0) {
        lines.push({ orderItemId: item.id, quantity: quantityText(String(take)), disposition: "restockable" });
        remaining -= take;
      }
    }
  }
  return lines;
}

async function ingestRefund(connection: ConnectionRow, refund: WooRefund, inboxId: string): Promise<void> {
  const businessId = connection.business_id;
  const remoteId = String(refund.id);

  const amount = wooAmountToRial(refund.amount ?? "0", connection.currency_unit);
  const tax = refund.total_tax ? wooAmountToRial(refund.total_tax, connection.currency_unit) : 0n;
  if (tax > amount) throw new Error("tax_exceeds_refund");
  const net = amount - tax;
  const locationId = await resolveLocationId(connection);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Same race-proofing as ingestOrder: two refund deliveries of one refund
    // must not double-post.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`woo-refund:${connection.id}:${remoteId}`]);
    const { rows: mapped } = await client.query(
      `SELECT 1 FROM integration_mappings
        WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'refund' AND remote_id = $3`,
      [businessId, connection.id, remoteId],
    );
    if (mapped.length > 0) {
      await client.query("ROLLBACK");
      return;
    }

    // Tie the refund to the imported order (via the order mapping) and, for
    // line items whose products were mapped at import time, reverse the
    // inventory deduction and COGS through the shared customer-return path —
    // exactly like a POS return. A refund that can't be tied to local order
    // items (unmapped at import, amount-only refund, unknown order) still
    // posts the money side.
    let recoveredValueRial = "0";
    const { rows: orderRows } = await client.query<{ id: string }>(
      `SELECT local_id::text AS id FROM integration_mappings
        WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'order' AND remote_id = $3`,
      [businessId, connection.id, String(refund.parent_id)],
    );
    const orderId = orderRows[0]?.id ?? null;
    const returnLines = orderId ? await buildRefundReturnLines(client, businessId, connection, orderId, refund) : [];

    if (orderId && returnLines.length > 0) {
      const result = await createCustomerReturn(client, {
        businessId,
        locationId,
        orderId,
        refundMethod: "online",
        refundAmount: amount.toString() as RialText,
        reason: refund.reason?.trim() || "WooCommerce refund",
        idempotencyKey: `woo-refund:${connection.id}:${remoteId}`,
        createdBy: null,
        lines: returnLines,
      });
      recoveredValueRial = result.recoveredValue;
    } else {
      const accounts = await accountIdsByCode(client, businessId, [
        WELL_KNOWN_CODES.salesReturns,
        WELL_KNOWN_CODES.vatPayable,
        WELL_KNOWN_CODES.bankClearing,
      ]);
      await postExactJournalEntry(client, {
        businessId,
        locationId,
        memo: `برگشت از فروش ووکامرس #${refund.id}`,
        sourceType: "woocommerce_refund",
        sourceId: inboxId,
        createdBy: null,
        postingKind: "customer_refund",
        lines: [
          { accountId: accounts.get(WELL_KNOWN_CODES.salesReturns)!, debit: net.toString() as RialText, credit: zero },
          ...(tax > 0n
            ? [{ accountId: accounts.get(WELL_KNOWN_CODES.vatPayable)!, debit: tax.toString() as RialText, credit: zero }]
            : []),
          { accountId: accounts.get(WELL_KNOWN_CODES.bankClearing)!, debit: zero, credit: amount.toString() as RialText },
        ],
      });
    }
    await client.query(
      `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
       VALUES ($1, $2, 'refund', $3, $4)
       ON CONFLICT (connection_id, entity_type, remote_id) DO NOTHING`,
      [businessId, connection.id, remoteId, inboxId],
    );
    await client.query("COMMIT");

    await writeIntegrationAudit({
      businessId,
      connectionId: connection.id,
      action: "refund.imported",
      entityType: "refund",
      remoteId,
      payload: { amountRial: amount.toString(), parentRemoteId: String(refund.parent_id), recoveredValueRial },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
