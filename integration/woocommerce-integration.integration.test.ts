/**
 * Phase 23 (issue #118) — the WooCommerce webhook ingest path end-to-end
 * against a real database: a signed `order.created` delivery becomes a
 * completed delivery order + online payment + a balanced revenue journal
 * entry, a re-delivery is a no-op, an unsigned delivery is refused, and a
 * `refund.created` posts a balanced refund entry.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { encryptSecret } from "../src/lib/integrations/secrets";
import { wooWebhookSignature } from "../src/lib/integrations/webhook-signature";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db") | undefined;
let ingest: typeof import("../src/lib/integrations/webhook-ingest-service");

const KEY = "ab".repeat(32);
const webhookSecret = "test-webhook-secret";

const biz = { id: "", locationId: "", connectionId: "" };

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

function orderPayload(id: number, total: string, totalTax: string) {
  return JSON.stringify({
    id,
    number: String(1000 + id),
    status: "processing",
    total,
    total_tax: totalTax,
    currency: "IRT",
    date_created: new Date().toISOString(),
    payment_method: "cod",
    line_items: [{ id: 1, name: "پیتزا", product_id: 1, quantity: 2, price: String(Number(total) / 2), total }],
    billing: { first_name: "علی", last_name: "محمدی" },
  });
}

beforeAll(async () => {
  databaseName = `pos_woo_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  process.env.INTEGRATIONS_ENCRYPTION_KEY = KEY;
  dbLib = await import("../src/lib/db");
  ingest = await import("../src/lib/integrations/webhook-ingest-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Woo Store', $1) RETURNING id",
    [`woo-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;
  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;

  await db.query(
    `INSERT INTO accounts (business_id, code, name, type) VALUES
       ($1, '1120', 'Card clearing', 'asset'),
       ($1, '4330', 'Delivery', 'revenue'),
       ($1, '2200', 'VAT Payable', 'liability'),
       ($1, '4400', 'Sales Returns', 'revenue')`,
    [biz.id],
  );

  const connRow = await db.query<{ id: string }>(
    `INSERT INTO integration_connections
       (business_id, location_id, name, base_url,
        consumer_key_ciphertext, consumer_secret_ciphertext, webhook_secret_ciphertext,
        currency_unit, sync_orders, sync_products, sync_customers, push_stock, push_prices)
     VALUES ($1, $2, 'Store', 'https://shop.example.com', $3, $4, $5, 'toman', true, true, true, true, true)
     RETURNING id`,
    [
      biz.id,
      biz.locationId,
      encryptSecret("ck_test", Buffer.from(KEY, "hex")),
      encryptSecret("cs_test", Buffer.from(KEY, "hex")),
      encryptSecret(webhookSecret, Buffer.from(KEY, "hex")),
    ],
  );
  biz.connectionId = connRow.rows[0].id;
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  delete process.env.INTEGRATIONS_ENCRYPTION_KEY;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

function signedHeaders(body: string, topic: string, deliveryId: string): Headers {
  return new Headers({
    "x-wc-webhook-signature": wooWebhookSignature(body, webhookSecret),
    "x-wc-webhook-delivery-id": deliveryId,
    "x-wc-webhook-topic": topic,
  });
}

describe("WooCommerce webhook ingest", () => {
  it("imports an order: completed delivery order + online payment + balanced revenue entry", async () => {
    const body = orderPayload(1, "10000", "1000"); // 10,000 toman = 100,000 rial, 1,000 toman tax
    const res = await ingest.handleWooCommerceWebhook(biz.connectionId, body, signedHeaders(body, "order.created", `d-${randomUUID()}`));
    expect(res.status).toBe(200);

    const orders = await db.query<{ id: string; type: string; status: string; total: string; tax: string; subtotal: string }>(
      "SELECT id, type, status, total, tax, subtotal FROM orders WHERE location_id = $1",
      [biz.locationId],
    );
    expect(orders.rowCount).toBe(1);
    expect(orders.rows[0]).toMatchObject({ type: "delivery", status: "completed", total: "100000", tax: "10000", subtotal: "90000" });

    const payments = await db.query("SELECT method, amount FROM payments WHERE order_id = $1", [orders.rows[0].id]);
    expect(payments.rows).toEqual([{ method: "online", amount: "100000" }]);

    const entry = await db.query<{ id: string }>(
      "SELECT id FROM journal_entries WHERE business_id = $1 AND source_type = 'woocommerce_order' AND posting_kind = 'revenue'",
      [biz.id],
    );
    expect(entry.rowCount).toBe(1);
    const lines = await db.query<{ code: string; debit: string; credit: string }>(
      `SELECT a.code, jl.debit, jl.credit FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
        WHERE jl.entry_id = $1 ORDER BY jl.debit DESC`,
      [entry.rows[0].id],
    );
    expect(lines.rows).toEqual([
      { code: "1120", debit: "100000", credit: "0" },
      { code: "4330", debit: "0", credit: "90000" },
      { code: "2200", debit: "0", credit: "10000" },
    ]);

    const mapping = await db.query(
      "SELECT 1 FROM integration_mappings WHERE connection_id = $1 AND entity_type = 'order' AND remote_id = '1'",
      [biz.connectionId],
    );
    expect(mapping.rowCount).toBe(1);
  });

  it("is idempotent across a second delivery of the same order (order.updated)", async () => {
    const body = orderPayload(1, "10000", "1000");
    const res = await ingest.handleWooCommerceWebhook(biz.connectionId, body, signedHeaders(body, "order.updated", `d-${randomUUID()}`));
    expect(res.status).toBe(200);

    const orders = await db.query("SELECT count(*)::int AS n FROM orders WHERE location_id = $1", [biz.locationId]);
    expect(orders.rows[0].n).toBe(1);
  });

  it("refuses a delivery with an invalid signature before touching the database", async () => {
    const body = orderPayload(2, "5000", "500");
    const headers = signedHeaders(body, "order.created", `d-${randomUUID()}`);
    headers.set("x-wc-webhook-signature", wooWebhookSignature(body, "wrong-secret"));
    const res = await ingest.handleWooCommerceWebhook(biz.connectionId, body, headers);
    expect(res.status).toBe(401);

    const orders = await db.query("SELECT count(*)::int AS n FROM orders WHERE location_id = $1", [biz.locationId]);
    expect(orders.rows[0].n).toBe(1);
  });

  it("posts a balanced refund entry for refund.created", async () => {
    const body = JSON.stringify({ id: 77, date_created: new Date().toISOString(), amount: "2000", total_tax: "200", reason: "return" });
    const res = await ingest.handleWooCommerceWebhook(biz.connectionId, body, signedHeaders(body, "refund.created", `d-${randomUUID()}`));
    expect(res.status).toBe(200);

    const entry = await db.query<{ id: string }>(
      "SELECT id FROM journal_entries WHERE business_id = $1 AND source_type = 'woocommerce_refund'",
      [biz.id],
    );
    expect(entry.rowCount).toBe(1);
    const lines = await db.query<{ code: string; debit: string; credit: string }>(
      `SELECT a.code, jl.debit, jl.credit FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
        WHERE jl.entry_id = $1 ORDER BY jl.debit DESC`,
      [entry.rows[0].id],
    );
    // 2,000 toman = 20,000 rial, 200 toman = 2,000 rial tax → net 18,000.
    expect(lines.rows).toEqual([
      { code: "4400", debit: "18000", credit: "0" },
      { code: "2200", debit: "2000", credit: "0" },
      { code: "1120", debit: "0", credit: "20000" },
    ]);
  });
});
