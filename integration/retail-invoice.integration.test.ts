/**
 * Phase 25 Wave 3 — a retail sale becomes a document, and posts exactly as it
 * always did.
 *
 * The load-bearing claim of this wave is that `createRetailInvoice` adds a
 * *record* of a sale without adding a second way to account for one: it writes
 * `orders`/`order_items` and then calls Phase 21's own sell services, unchanged,
 * inside the same transaction. So the assertions that matter most are not about
 * the new rows — they are that the journal lines a multi-line invoice produces
 * are the same lines the per-item panel produced, arithmetic included, matching
 * integration/gold-sales.integration.test.ts's stated expectations.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let itemsService: typeof import("../src/lib/items-service");
let goldPricesService: typeof import("../src/lib/gold-prices-service");
let accessoriesService: typeof import("../src/lib/accessories-service");
let invoiceService: typeof import("../src/lib/retail-invoice-service");

const biz = { id: "", locationId: "" };
const acct: Record<string, string> = {};

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

beforeAll(async () => {
  databaseName = `pos_retail_invoice_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  itemsService = await import("../src/lib/items-service");
  goldPricesService = await import("../src/lib/gold-prices-service");
  accessoriesService = await import("../src/lib/accessories-service");
  invoiceService = await import("../src/lib/retail-invoice-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

const ACCOUNT_SEED: [string, string, string, string][] = [
  ["cash", "1100", "Cash", "asset"],
  ["goldSalesRevenue", "4500", "Gold Sales Revenue", "revenue"],
  ["makingChargeRevenue", "4600", "Making Charge Revenue", "revenue"],
  ["vatPayable", "2200", "VAT Payable", "liability"],
  ["goldCogs", "5110", "Gold COGS", "expense"],
  ["goldInventory", "1320", "Gold Inventory", "asset"],
  ["accessorySalesRevenue", "4560", "Accessory Sales Revenue", "revenue"],
  ["accessoryCogs", "5140", "Accessory COGS", "expense"],
  ["accessoryInventory", "1340", "Accessory Inventory", "asset"],
];

async function seedBusiness(industry: string) {
  // A settled invoice's lines are immutable (guard_order_item_mutation,
  // migration 0014) — which is the point of this wave's `orders` reuse, and is
  // asserted below. Between tests we take the same transaction-local escape
  // hatch the confirmed factory reset takes (migration 0036), rather than
  // weakening the guard for everyone.
  await db.query("ROLLBACK").catch(() => {});
  await db.query("BEGIN");
  await db.query("SELECT set_config('app.factory_reset', 'true', true)");
  await db.query("DELETE FROM domain_events");
  await db.query("DELETE FROM payments");
  await db.query("DELETE FROM order_items");
  await db.query("DELETE FROM orders");
  await db.query("DELETE FROM order_number_counters");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM item_stock");
  await db.query("DELETE FROM item_weight_attributes");
  await db.query("DELETE FROM items");
  await db.query("DELETE FROM gold_prices");
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM businesses");
  await db.query("COMMIT");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Retail Co', $1, $2) RETURNING id",
    [`retail-${randomUUID().slice(0, 8)}`, industry],
  );
  biz.id = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;

  for (const [key, code, name, type] of ACCOUNT_SEED) {
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO accounts (business_id, code, name, type) VALUES ($1, $2, $3, $4) RETURNING id",
      [biz.id, code, name, type],
    );
    acct[key] = rows[0].id;
  }
}

async function makeBracelet(netWeight: string, unitCostPerGram: string) {
  const item = await itemsService.createItem({
    locationId: biz.locationId,
    name: "دستبند طلا",
    tracking: "weight",
  });
  await itemsService.setWeightAttributes(item.id, {
    purity: "18",
    grossWeight: netWeight,
    netWeight,
    unitCostPerGram,
  });
  return item;
}

async function invoice(input: Parameters<typeof invoiceService.createRetailInvoice>[1]) {
  const client = await dbLib.getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await invoiceService.createRetailInvoice(client, input);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

describe("a jewellery invoice", () => {
  beforeEach(async () => {
    await seedBusiness("jewelry");
    await goldPricesService.recordGoldPrice({ businessId: biz.id, purity: "18", pricePerGram: 5_000_000 });
  });

  it("posts exactly what the per-item sell panel posted", async () => {
    // Same fixture as integration/gold-sales.integration.test.ts: 2.5g at
    // 5,000,000/g, 7% اجرت, 10% سود, 9% VAT. metalValue = 12,500,000;
    // makingCharge = 875,000; profit = 1,337,500; vat = 199,125;
    // total = 14,911,625. If routing the sale through an invoice changed any
    // of these, this is where it would show.
    const bracelet = await makeBracelet("2.5", "4000000");
    const result = await invoice({
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "jewelry",
      paymentMethod: "cash",
      lines: [
        {
          kind: "gold",
          itemId: bracelet.id,
          makingChargeType: "percent",
          makingChargeValue: 7,
          profitPercent: 10,
          vatPercent: 9,
        },
      ],
    });

    expect(result.total).toBe("14911625");

    const { rows: entries } = await db.query<{ id: string }>(
      "SELECT id FROM journal_entries WHERE business_id = $1",
      [biz.id],
    );
    // One revenue entry and one COGS entry — the same two the sell service
    // always emitted, and no third entry from the invoice itself.
    expect(entries).toHaveLength(2);

    // Found by content, not by order: both entries are posted in the same
    // transaction, so `posted_at` is identical and the id is random. The
    // revenue entry is the one that debits cash.
    const { rows: revenueEntry } = await db.query<{ entry_id: string }>(
      `SELECT DISTINCT entry_id FROM journal_lines
        WHERE entry_id = ANY($1) AND account_id = $2 AND debit > 0`,
      [entries.map((e) => e.id), acct.cash],
    );
    expect(revenueEntry).toHaveLength(1);

    const { rows: revenueLines } = await db.query<{ account_id: string; debit: string; credit: string }>(
      "SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY debit DESC",
      [revenueEntry[0].entry_id],
    );
    expect(revenueLines).toEqual([
      { account_id: acct.cash, debit: "14911625", credit: "0" },
      { account_id: acct.goldSalesRevenue, debit: "0", credit: "12500000" },
      { account_id: acct.makingChargeRevenue, debit: "0", credit: "2212500" },
      { account_id: acct.vatPayable, debit: "0", credit: "199125" },
    ]);
  });

  it("writes the invoice, its lines and its payment", async () => {
    const bracelet = await makeBracelet("2.5", "4000000");
    const result = await invoice({
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "jewelry",
      paymentMethod: "cash",
      lines: [
        {
          kind: "gold",
          itemId: bracelet.id,
          makingChargeType: "percent",
          makingChargeValue: 7,
          profitPercent: 10,
          vatPercent: 9,
        },
      ],
    });

    const { rows: orders } = await db.query<{
      id: string;
      type: string;
      status: string;
      order_number: string;
      total: string;
      tax: string;
    }>("SELECT id, type, status, order_number, total, tax FROM orders WHERE location_id = $1", [
      biz.locationId,
    ]);
    expect(orders).toHaveLength(1);
    expect(orders[0].type).toBe("retail");
    // Settled on the spot: a shop counter has no open-ticket stage.
    expect(orders[0].status).toBe("completed");
    expect(orders[0].total).toBe("14911625");
    expect(orders[0].tax).toBe("199125");
    expect(Number(orders[0].order_number)).toBe(result.orderNumber);

    const { rows: items } = await db.query<{
      item_id: string;
      name_snapshot: string;
      metal_value: string;
      making_charge: string;
      profit: string;
    }>("SELECT item_id, name_snapshot, metal_value, making_charge, profit FROM order_items WHERE order_id = $1", [
      orders[0].id,
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].item_id).toBe(bracelet.id);
    expect(items[0].name_snapshot).toBe("دستبند طلا");
    // The breakdown is kept, not recomputed: a reprint next month must show
    // what the customer was actually charged, not today's gold rate.
    expect(items[0].metal_value).toBe("12500000");
    expect(items[0].making_charge).toBe("875000");
    expect(items[0].profit).toBe("1337500");

    const { rows: payments } = await db.query<{ method: string; amount: string }>(
      "SELECT method, amount FROM payments WHERE order_id = $1",
      [orders[0].id],
    );
    expect(payments).toEqual([{ method: "cash", amount: "14911625" }]);
  });

  it("puts several pieces on one invoice and totals them", async () => {
    const a = await makeBracelet("2", "4000000");
    const b = await makeBracelet("1", "4000000");
    const line = { kind: "gold" as const, makingChargeType: "percent" as const, makingChargeValue: 7, profitPercent: 10, vatPercent: 9 };

    const result = await invoice({
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "jewelry",
      paymentMethod: "cash",
      lines: [
        { ...line, itemId: a.id },
        { ...line, itemId: b.id },
      ],
    });

    expect(result.lines).toHaveLength(2);
    expect(BigInt(result.total)).toBe(
      BigInt(result.lines[0].total) + BigInt(result.lines[1].total),
    );
    // Both pieces are gone from stock — each line went through the real sell
    // service, not just onto the document.
    const { rows } = await db.query<{ status: string }>(
      "SELECT status FROM item_weight_attributes WHERE item_id = ANY($1)",
      [[a.id, b.id]],
    );
    expect(rows.map((r) => r.status)).toEqual(["sold", "sold"]);
  });

  it("rolls the whole invoice back when one line cannot be sold", async () => {
    const sellable = await makeBracelet("2", "4000000");
    // No cost basis recorded, so the sell service refuses this one.
    const broken = await itemsService.createItem({
      locationId: biz.locationId,
      name: "انگشتر بدون بها",
      tracking: "weight",
    });
    await itemsService.setWeightAttributes(broken.id, {
      purity: "18",
      grossWeight: "1",
      netWeight: "1",
      unitCostPerGram: null,
    });
    const line = { kind: "gold" as const, makingChargeType: "percent" as const, makingChargeValue: 7, profitPercent: 10, vatPercent: 9 };

    await expect(
      invoice({
        businessId: biz.id,
        locationId: biz.locationId,
        industry: "jewelry",
        paymentMethod: "cash",
        lines: [
          { ...line, itemId: sellable.id },
          { ...line, itemId: broken.id },
        ],
      }),
    ).rejects.toThrow();

    // Nothing partial survives: no order, no postings, and the first piece is
    // still in stock. This is why settlement happens inside the same
    // transaction as the document.
    const { rows: orders } = await db.query("SELECT id FROM orders WHERE location_id = $1", [biz.locationId]);
    expect(orders).toHaveLength(0);
    const { rows: entries } = await db.query("SELECT id FROM journal_entries WHERE business_id = $1", [biz.id]);
    expect(entries).toHaveLength(0);
    const { rows: status } = await db.query<{ status: string }>(
      "SELECT status FROM item_weight_attributes WHERE item_id = $1",
      [sellable.id],
    );
    expect(status[0].status).toBe("in_stock");
  });

  it("refuses a line kind this industry does not sell", async () => {
    await expect(
      invoice({
        businessId: biz.id,
        locationId: biz.locationId,
        industry: "jewelry",
        paymentMethod: "cash",
        lines: [{ kind: "accessory", itemId: randomUUID(), quantity: "1", vatPercent: 9 }],
      }),
    ).rejects.toThrow(invoiceService.RetailInvoiceError);
  });

  it("refuses an empty invoice", async () => {
    await expect(
      invoice({
        businessId: biz.id,
        locationId: biz.locationId,
        industry: "jewelry",
        paymentMethod: "cash",
        lines: [],
      }),
    ).rejects.toThrow(invoiceService.RetailInvoiceError);
  });
});

describe("an accessories invoice", () => {
  beforeEach(async () => {
    await seedBusiness("accessories");
  });

  it("decrements stock and posts revenue and COGS", async () => {
    const family = await itemsService.createItem({
      locationId: biz.locationId,
      name: "دستبند بدلیجات",
      kind: "variant_parent",
    });
    const variant = await itemsService.createVariantChild(family.id, biz.locationId, "قرمز", null, [
      { name: "رنگ", value: "قرمز" },
    ]);

    await accessoriesService.receiveStock(variant.id, { quantity: "10", unitCost: 20_000 });
    await accessoriesService.setUnitPrice(variant.id, 50_000);

    const result = await invoice({
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "accessories",
      paymentMethod: "cash",
      lines: [{ kind: "accessory", itemId: variant.id, quantity: "3", vatPercent: 9 }],
    });

    // 3 × 50,000 = 150,000 net; VAT 13,500; total 163,500.
    expect(result.subtotal).toBe("150000");
    expect(result.tax).toBe("13500");
    expect(result.total).toBe("163500");

    const { rows: stock } = await db.query<{ quantity: string }>(
      "SELECT quantity FROM item_stock WHERE item_id = $1",
      [variant.id],
    );
    expect(Number(stock[0].quantity)).toBe(7);

    const { rows: entries } = await db.query("SELECT id FROM journal_entries WHERE business_id = $1", [biz.id]);
    // Revenue + COGS from the sale; the stock receipt above posted its own.
    expect(entries.length).toBeGreaterThanOrEqual(2);
  });

  it("refuses to oversell", async () => {
    const family = await itemsService.createItem({
      locationId: biz.locationId,
      name: "گردنبند",
      kind: "variant_parent",
    });
    const variant = await itemsService.createVariantChild(family.id, biz.locationId, "آبی", null, [
      { name: "رنگ", value: "آبی" },
    ]);
    await accessoriesService.receiveStock(variant.id, { quantity: "2", unitCost: 20_000 });
    await accessoriesService.setUnitPrice(variant.id, 50_000);

    await expect(
      invoice({
        businessId: biz.id,
        locationId: biz.locationId,
        industry: "accessories",
        paymentMethod: "cash",
        lines: [{ kind: "accessory", itemId: variant.id, quantity: "5", vatPercent: 9 }],
      }),
    ).rejects.toThrow();
  });
});

describe("invoice numbering", () => {
  beforeEach(async () => {
    await seedBusiness("jewelry");
    await goldPricesService.recordGoldPrice({ businessId: biz.id, purity: "18", pricePerGram: 5_000_000 });
  });

  it("uses the branch's order-number sequence, so numbers cannot collide with orders", async () => {
    const line = { kind: "gold" as const, makingChargeType: "percent" as const, makingChargeValue: 7, profitPercent: 10, vatPercent: 9 };
    const first = await invoice({
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "jewelry",
      paymentMethod: "cash",
      lines: [{ ...line, itemId: (await makeBracelet("1", "4000000")).id }],
    });
    const second = await invoice({
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "jewelry",
      paymentMethod: "cash",
      lines: [{ ...line, itemId: (await makeBracelet("1", "4000000")).id }],
    });
    expect(second.orderNumber).toBe(first.orderNumber + 1);
  });
});
