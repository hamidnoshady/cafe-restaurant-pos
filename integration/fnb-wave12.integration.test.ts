/**
 * Phase 27 Wave 12 — the food-service half: recipe cost-drift alerts and
 * read-only waste analytics.
 *
 * Cost-drift flags an item whose ingredient cost rose past the business's
 * threshold and reports its old and new margin; the waste report's movement
 * total must tie to the waste-expense account's ledger balance.
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
let fnbReports: typeof import("../src/lib/fnb-reports-service");

const biz = { id: "" };
const loc = { id: "" };

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
  databaseName = `pos_wave12_${randomUUID().replaceAll("-", "")}`;
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
  fnbReports = await import("../src/lib/fnb-reports-service");

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
  await db.query("DELETE FROM stock_movements");
  await db.query("DELETE FROM menu_item_ingredients");
  await db.query("DELETE FROM menu_items");
  await db.query("DELETE FROM inventory_items");
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM locations");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Café Co', $1, 'food_service') RETURNING id",
    [`wave12-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;
  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  loc.id = locRow.rows[0].id;
});

async function makeMenuItem(price: number, targetMargin: number | null) {
  const category = await db.query<{ id: string }>(
    "INSERT INTO menu_categories (location_id, name) VALUES ($1, 'Drinks') RETURNING id",
    [loc.id],
  );
  const menu = await db.query<{ id: string }>(
    `INSERT INTO menu_items (location_id, category_id, name, price, target_margin_percent)
     VALUES ($1, $2, 'Item', $3, $4) RETURNING id`,
    [loc.id, category.rows[0].id, price, targetMargin],
  );
  return menu.rows[0].id;
}

describe("listMenuCostDrift", () => {
  it("flags an item whose ingredient cost rose past the threshold, and leaves one within it alone", async () => {
    const beans = await db.query<{ id: string }>(
      "INSERT INTO inventory_items (location_id, name, unit, avg_cost) VALUES ($1, 'Beans', 'g', 100) RETURNING id",
      [loc.id],
    );
    const beanId = beans.rows[0].id;

    // price 10,000 at a 20% target margin implies a reference cost of 8,000.
    const drifted = await makeMenuItem(10_000, 20);
    // 100g × 100 = 10,000 material cost → a 25% rise over 8,000.
    await db.query(
      "INSERT INTO menu_item_ingredients (menu_item_id, inventory_item_id, quantity) VALUES ($1, $2, 100)",
      [drifted, beanId],
    );

    const within = await makeMenuItem(10_000, 20);
    // 90g × 100 = 9,000 material cost → a 12.5% rise, within 20%.
    await db.query(
      "INSERT INTO menu_item_ingredients (menu_item_id, inventory_item_id, quantity) VALUES ($1, $2, 90)",
      [within, beanId],
    );

    await pricingService.setPricingConfig(biz.id, {
      defaultMarginPercent: 20,
      fallbackOverheadPercent: null,
      costDriftThresholdPercent: 20,
    });

    const rows = await pricingService.listMenuCostDrift(biz.id, loc.id);
    expect(rows.map((r) => r.menuItemId)).toEqual([drifted]);
    expect(rows[0].oldMarginPercent).toBe(20);
    expect(rows[0].newMarginPercent).toBe(0);
  });

  it("uses the default margin and compares loaded costs when an item has no override", async () => {
    const beans = await db.query<{ id: string }>(
      "INSERT INTO inventory_items (location_id, name, unit, avg_cost) VALUES ($1, 'Beans', 'g', 100) RETURNING id",
      [loc.id],
    );
    // At a 20% target margin, a 12,500 price implies 10,000 of loaded
    // reference cost. Today's 10,000 material cost plus 25% fixed overhead is
    // 12,500 — a 25% rise that must be flagged.
    const menuItemId = await makeMenuItem(12_500, null);
    await db.query(
      "INSERT INTO menu_item_ingredients (menu_item_id, inventory_item_id, quantity) VALUES ($1, $2, 100)",
      [menuItemId, beans.rows[0].id],
    );
    await pricingService.setPricingConfig(biz.id, {
      defaultMarginPercent: 20,
      fallbackOverheadPercent: 25,
      overheadMode: "manual",
      costDriftThresholdPercent: 20,
    });

    const rows = await pricingService.listMenuCostDrift(biz.id, loc.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      menuItemId,
      currentCost: 12_500,
      referenceCost: 10_000,
      costChangePercent: 25,
      oldMarginPercent: 20,
      newMarginPercent: 0,
    });
  });
});

describe("wasteReport", () => {
  it("ties the movement total to the waste-expense ledger balance", async () => {
    await db.query(
      `INSERT INTO accounts (business_id, code, name, type)
       VALUES ($1, '5150', 'Waste', 'expense'), ($1, '1300', 'Inventory', 'asset')`,
      [biz.id],
    );
    const wasteAcct = await db.query<{ id: string }>(
      "SELECT id FROM accounts WHERE business_id = $1 AND code = '5150'",
      [biz.id],
    );
    const inv = await db.query<{ id: string }>(
      "INSERT INTO inventory_items (location_id, name, unit, avg_cost) VALUES ($1, 'Milk', 'L', 1000) RETURNING id",
      [loc.id],
    );

    await db.query(
      `INSERT INTO stock_movements (location_id, inventory_item_id, type, quantity, unit_cost, waste_reason, occurred_at)
       VALUES ($1, $2, 'waste', -2, 1000, 'spoilage', '2026-08-10')`,
      [loc.id, inv.rows[0].id],
    );

    const entry = await db.query<{ id: string }>(
      "INSERT INTO journal_entries (business_id, entry_date, memo) VALUES ($1, '2026-08-10', 'waste') RETURNING id",
      [biz.id],
    );
    await db.query(
      "INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, 2000, 0)",
      [entry.rows[0].id, wasteAcct.rows[0].id],
    );

    const report = await fnbReports.wasteReport(biz.id, loc.id, { from: "2026-08-01", to: "2026-08-31" });
    expect(report.rows).toEqual([{ reason: "spoilage", quantity: "2.000000000", cost: 2000 }]);
    expect(report.totalCost).toBe(2000);
    expect(report.ledgerWasteExpense).toBe(2000);
  });
});
