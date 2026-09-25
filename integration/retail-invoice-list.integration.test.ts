/**
 * `listRetailInvoices` — the query behind «مدیریت فاکتورها» and its new
 * status/date-range filters (this wave). Extracted out of the API route so it
 * can be exercised directly against a real database: a fake `NextRequest` and
 * session would only be noise here, the query itself is what needs proving.
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
let invoiceService: typeof import("../src/lib/retail-invoice-service");
let listService: typeof import("../src/lib/retail-invoice/list-service");

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
  databaseName = `pos_retail_invoice_list_${randomUUID().replaceAll("-", "")}`;

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
  invoiceService = await import("../src/lib/retail-invoice-service");
  listService = await import("../src/lib/retail-invoice/list-service");

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
];

async function seedBusiness() {
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
  await db.query("DELETE FROM parties");
  await db.query("DELETE FROM businesses");
  await db.query("COMMIT");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Retail Co', $1, 'jewelry') RETURNING id",
    [`retail-list-${randomUUID().slice(0, 8)}`],
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

function baseInput(overrides: Partial<Parameters<typeof listService.listRetailInvoices>[0]> = {}) {
  return {
    businessId: biz.id,
    locationId: biz.locationId,
    q: "",
    method: "",
    status: "",
    dateFrom: "",
    dateTo: "",
    installmentEligible: false,
    page: 1,
    pageSize: 20,
    ...overrides,
  };
}

describe("listRetailInvoices", () => {
  beforeEach(async () => {
    await seedBusiness();
    await goldPricesService.recordGoldPrice({ businessId: biz.id, purity: "18", pricePerGram: 5_000_000 });
  });

  it("filters by status without needing a Next.js request/session", async () => {
    const bracelet = await makeBracelet("1", "4000000");
    const result = await invoice({
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "jewelry",
      paymentMethod: "cash",
      lines: [
        { kind: "gold", itemId: bracelet.id, makingChargeType: "percent", makingChargeValue: 7, profitPercent: 10, vatPercent: 9 },
      ],
    });
    // No void flow is exercised here (out of this wave's scope) — this only
    // proves the filter itself, by flipping the status directly.
    await db.query("UPDATE orders SET status = 'voided' WHERE id = $1", [result.orderId]);

    const completedOnly = await listService.listRetailInvoices(baseInput({ status: "completed" }));
    expect(completedOnly.invoices).toHaveLength(0);

    const voidedOnly = await listService.listRetailInvoices(baseInput({ status: "voided" }));
    expect(voidedOnly.invoices).toHaveLength(1);
    expect(voidedOnly.invoices[0].status).toBe("voided");

    const all = await listService.listRetailInvoices(baseInput());
    expect(all.invoices).toHaveLength(1);
  });

  it("filters by a Jalali-picked date range, bucketed by the branch's business day", async () => {
    const bracelet1 = await makeBracelet("1", "4000000");
    const older = await invoice({
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "jewelry",
      paymentMethod: "cash",
      lines: [
        { kind: "gold", itemId: bracelet1.id, makingChargeType: "percent", makingChargeValue: 7, profitPercent: 10, vatPercent: 9 },
      ],
    });
    // Backdate this one — `createRetailInvoice` always stamps `now()`, so a
    // date-range test needs an invoice that is not from today.
    await db.query("UPDATE orders SET closed_at = '2024-01-05T10:00:00Z' WHERE id = $1", [older.orderId]);

    const bracelet2 = await makeBracelet("1", "4000000");
    await invoice({
      businessId: biz.id,
      locationId: biz.locationId,
      industry: "jewelry",
      paymentMethod: "cash",
      lines: [
        { kind: "gold", itemId: bracelet2.id, makingChargeType: "percent", makingChargeValue: 7, profitPercent: 10, vatPercent: 9 },
      ],
    });

    const onlyOld = await listService.listRetailInvoices(
      baseInput({ dateFrom: "2024-01-01", dateTo: "2024-01-10" }),
    );
    expect(onlyOld.invoices).toHaveLength(1);
    expect(onlyOld.invoices[0].orderNumber).toBe(older.orderNumber);

    const excludingOld = await listService.listRetailInvoices(baseInput({ dateFrom: "2024-02-01" }));
    expect(excludingOld.invoices).toHaveLength(1);
    expect(excludingOld.invoices[0].orderNumber).not.toBe(older.orderNumber);

    const both = await listService.listRetailInvoices(baseInput());
    expect(both.invoices).toHaveLength(2);
  });

  it("paginates and reports the total count across pages, not just the page returned", async () => {
    for (let i = 0; i < 3; i++) {
      const bracelet = await makeBracelet("1", "4000000");
      await invoice({
        businessId: biz.id,
        locationId: biz.locationId,
        industry: "jewelry",
        paymentMethod: "cash",
        lines: [
          { kind: "gold", itemId: bracelet.id, makingChargeType: "percent", makingChargeValue: 7, profitPercent: 10, vatPercent: 9 },
        ],
      });
    }

    const firstPage = await listService.listRetailInvoices(baseInput({ pageSize: 2, page: 1 }));
    expect(firstPage.invoices).toHaveLength(2);
    expect(firstPage.count).toBe(3);

    const secondPage = await listService.listRetailInvoices(baseInput({ pageSize: 2, page: 2 }));
    expect(secondPage.invoices).toHaveLength(1);
    expect(secondPage.count).toBe(3);
  });
});
