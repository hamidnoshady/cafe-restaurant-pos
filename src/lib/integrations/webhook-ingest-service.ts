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
import { accountIdsByCode, postExactJournalEntry } from "../ledger-service";
import type { RialText } from "../inventory-exact";
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
import type { WooOrder, WooRefund } from "./woocommerce-client";

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

async function processWebhookEvent(connection: ConnectionRow, event: WebhookEvent): Promise<NextResponse> {
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
    return NextResponse.json({ ok: true, duplicate: true }, { status: 200 });
  }
  const inboxId = inserted[0].id;

  try {
    if (event.topic.endsWith("order.created") || event.topic.endsWith("order.updated") || event.topic.endsWith("order.restored")) {
      if (connection.sync_orders) {
        await ingestOrder(connection, event.payload as unknown as WooOrder);
      }
    } else if (event.topic.endsWith("refund.created")) {
      await ingestRefund(connection, event.payload as unknown as WooRefund, inboxId);
    }
    // Any other topic (product.updated, …) is acknowledged and left for a
    // future pull-based sync — we never want a re-delivery storm for an event
    // we don't handle yet.
    await query(`UPDATE integration_webhook_events SET status = 'processed', processed_at = now() WHERE id = $1`, [inboxId]);
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    const message = (err as Error).message;
    await query(`UPDATE integration_webhook_events SET status = 'failed', error = $2 WHERE id = $1`, [inboxId, message]);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
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

    for (const line of order.line_items ?? []) {
      const unitPrice = wooAmountToRial(line.price ?? "0", connection.currency_unit);
      const quantity = Math.max(1, Math.round(line.quantity ?? 1));
      await client.query(
        `INSERT INTO order_items (location_id, order_id, name_snapshot, unit_price, quantity, status)
         VALUES ($1, $2, $3, $4, $5, 'served')`,
        [locationId, orderId, line.name, unitPrice.toString(), quantity],
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
      lines: [
        { accountId: accounts.get(WELL_KNOWN_CODES.bankClearing)!, debit: total.toString() as RialText, credit: zero },
        { accountId: accounts.get(WELL_KNOWN_CODES.deliveryRevenue)!, debit: zero, credit: net.toString() as RialText },
        ...(tax > 0n
          ? [{ accountId: accounts.get(WELL_KNOWN_CODES.vatPayable)!, debit: zero, credit: tax.toString() as RialText }]
          : []),
      ],
    });

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
      payload: { orderNumber: order.number ?? remoteId, totalRial: total.toString() },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
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
      payload: { amountRial: amount.toString() },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
