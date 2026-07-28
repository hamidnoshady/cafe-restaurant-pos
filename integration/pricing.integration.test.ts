/**
 * getSuggestedPrice (src/lib/pricing-service.ts) ties together a menu item's
 * recipe cost, the ledger's P&L (for an overhead recovery rate), and a
 * target margin (item override or business default) — none of which
 * previously talked to each other. This proves the DB-touching wiring
 * against real recipe rows and posted journal entries (the pure math is
 * pricing.test.ts's job).
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
let pricingService: typeof import("../src/lib/pricing-service");

const biz = { id: "" };
const loc = { id: "" };
const acct = { cash: "", revenue: "", rent: "", salaries: "" };
const item = { menuItemId: "", inventoryItemId: "" };

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
  databaseName = `pos_pricing_${randomUUID().replaceAll("-", "")}`;

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
  pricingService = await import("../src/lib/pricing-service");

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

beforeEach(async () => {
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM menu_item_ingredients");
  await db.query("DELETE FROM menu_items");
  await db.query("DELETE FROM inventory_items");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Pricing Co', $1) RETURNING id",
    [`pricing-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  loc.id = locRow.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'), ($1, '4300', 'Sales', 'revenue'),
            ($1, '5300', 'Rent', 'expense'), ($1, '5200', 'Salaries', 'expense')
     RETURNING id, code`,
    [biz.id],
  );
  for (const r of accounts.rows) {
    if (r.code === "1100") acct.cash = r.id;
    if (r.code === "4300") acct.revenue = r.id;
    if (r.code === "5300") acct.rent = r.id;
    if (r.code === "5200") acct.salaries = r.id;
  }

  const invRow = await db.query<{ id: string }>(
    "INSERT INTO inventory_items (location_id, name, unit, avg_cost) VALUES ($1, 'Coffee beans', 'g', 500) RETURNING id",
    [loc.id],
  );
  item.inventoryItemId = invRow.rows[0].id;

  const category = await db.query<{ id: string }>(
    "INSERT INTO menu_categories (location_id, name) VALUES ($1, 'Drinks') RETURNING id",
    [loc.id],
  );
  const menuItemRow = await db.query<{ id: string }>(
    "INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1, $2, 'Espresso', 50000) RETURNING id",
    [loc.id, category.rows[0].id],
  );
  item.menuItemId = menuItemRow.rows[0].id;
});

/** Posts a balanced two-line entry directly, mirroring what postJournalEntry does. */
async function postEntry(entryDate: string, debitAcct: string, creditAcct: string, amount: number) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (business_id, entry_date, memo, source_type) VALUES ($1, $2, 'test', 'manual') RETURNING id`,
    [biz.id, entryDate],
  );
  await db.query(
    `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
    [rows[0].id, debitAcct, amount, creditAcct],
  );
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

describe("getSuggestedPrice", () => {
  it("returns null for a menu item that doesn't exist", async () => {
    expect(await pricingService.getSuggestedPrice(biz.id, randomUUID())).toBeNull();
  });

  it("reports no recipe and no suggestion when the item has no ingredients", async () => {
    const result = await pricingService.getSuggestedPrice(biz.id, item.menuItemId);
    expect(result?.hasRecipe).toBe(false);
    expect(result?.materialCost).toBe(0);
    expect(result?.suggestedPrice).toBeNull();
  });

  it("computes material cost from the recipe but leaves suggestedPrice null with no margin configured anywhere", async () => {
    await db.query(
      "INSERT INTO menu_item_ingredients (menu_item_id, inventory_item_id, quantity) VALUES ($1, $2, 18)",
      [item.menuItemId, item.inventoryItemId],
    );

    const result = await pricingService.getSuggestedPrice(biz.id, item.menuItemId);
    expect(result?.hasRecipe).toBe(true);
    expect(result?.materialCost).toBe(9_000); // 18g * 500 Rial/g
    expect(result?.marginSource).toBe("none");
    expect(result?.marginPercent).toBeNull();
    expect(result?.overheadRatePercent).toBeNull(); // no revenue posted at all
    expect(result?.loadedCost).toBe(9_000); // overhead treated as 0 when unknown
    expect(result?.suggestedPrice).toBeNull();
  });

  it("falls back to the business default margin when the item has no override", async () => {
    await db.query(
      "INSERT INTO menu_item_ingredients (menu_item_id, inventory_item_id, quantity) VALUES ($1, $2, 18)",
      [item.menuItemId, item.inventoryItemId],
    );
    await pricingService.setPricingConfig(biz.id, { defaultMarginPercent: 30 });

    const result = await pricingService.getSuggestedPrice(biz.id, item.menuItemId);
    expect(result?.marginSource).toBe("default");
    expect(result?.marginPercent).toBe(30);
    expect(result?.suggestedPrice).toBe(Math.round(9_000 / 0.7 / 10) * 10);
  });

  it("prefers the item's own margin override over the business default", async () => {
    await db.query(
      "INSERT INTO menu_item_ingredients (menu_item_id, inventory_item_id, quantity) VALUES ($1, $2, 18)",
      [item.menuItemId, item.inventoryItemId],
    );
    await pricingService.setPricingConfig(biz.id, { defaultMarginPercent: 30 });
    await db.query("UPDATE menu_items SET target_margin_percent = 45 WHERE id = $1", [item.menuItemId]);

    const result = await pricingService.getSuggestedPrice(biz.id, item.menuItemId);
    expect(result?.marginSource).toBe("item");
    expect(result?.marginPercent).toBe(45);
    expect(result?.suggestedPrice).toBe(Math.round(9_000 / 0.55 / 10) * 10);
  });

  it("derives the overhead recovery rate from the trailing 30 days of the ledger", async () => {
    await db.query(
      "INSERT INTO menu_item_ingredients (menu_item_id, inventory_item_id, quantity) VALUES ($1, $2, 18)",
      [item.menuItemId, item.inventoryItemId],
    );
    const day = today();
    await postEntry(day, acct.cash, acct.revenue, 1_000_000); // revenue
    await postEntry(day, acct.rent, acct.cash, 300_000); // operating expense
    await postEntry(day, acct.salaries, acct.cash, 100_000); // labor

    const result = await pricingService.getSuggestedPrice(biz.id, item.menuItemId);
    // overhead rate = (300,000 + 100,000) / 1,000,000 = 40%
    expect(result?.overheadRatePercent).toBe(40);
    expect(result?.loadedCost).toBe(Math.round(9_000 * 1.4));
  });
});
