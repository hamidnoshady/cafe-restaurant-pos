/**
 * Phase 21 Wave 3 exit criterion (partial): "A gold sale's receipt shows
 * the full price breakdown ... and posts a balanced journal entry via the
 * posting engine." Proves the whole chain end to end: an item with weight/
 * purity/cost attributes, a recorded daily price, sellWeightedItem
 * computing the breakdown and posting both the revenue entry (VAT applied
 * only to making charge + profit, never metal value) and the COGS entry,
 * and the sold piece's status flipping so it can never be sold twice.
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
let goldSalesService: typeof import("../src/lib/gold-sales-service");

const biz = { id: "", locationId: "" };
const acct = { cash: "", goldSalesRevenue: "", makingChargeRevenue: "", vatPayable: "", goldCogs: "", goldInventory: "" };

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
  databaseName = `pos_gold_sales_${randomUUID().replaceAll("-", "")}`;

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
  goldSalesService = await import("../src/lib/gold-sales-service");

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
  await db.query("DELETE FROM domain_events");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM item_stones");
  await db.query("DELETE FROM item_weight_attributes");
  await db.query("DELETE FROM items");
  await db.query("DELETE FROM gold_prices");
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Gold Co', $1, 'jewelry') RETURNING id",
    [`gold-sales-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'),
            ($1, '4500', 'Gold Sales Revenue', 'revenue'),
            ($1, '4600', 'Making Charge Revenue', 'revenue'),
            ($1, '2200', 'VAT Payable', 'liability'),
            ($1, '5110', 'Gold COGS', 'expense'),
            ($1, '1320', 'Gold Inventory', 'asset')
     RETURNING id, code`,
    [biz.id],
  );
  for (const row of accounts.rows) {
    if (row.code === "1100") acct.cash = row.id;
    if (row.code === "4500") acct.goldSalesRevenue = row.id;
    if (row.code === "4600") acct.makingChargeRevenue = row.id;
    if (row.code === "2200") acct.vatPayable = row.id;
    if (row.code === "5110") acct.goldCogs = row.id;
    if (row.code === "1320") acct.goldInventory = row.id;
  }
});

async function makeBraceletWithCost(unitCostPerGram: string) {
  const item = await itemsService.createItem({
    locationId: biz.locationId,
    name: "دستبند طلا",
    tracking: "weight",
  });
  await itemsService.setWeightAttributes(item.id, {
    purity: "18",
    grossWeight: "2.5",
    netWeight: "2.5",
    unitCostPerGram,
  });
  return item;
}

describe("sellWeightedItem", () => {
  it("posts a balanced revenue entry and a balanced COGS entry, and marks the item sold", async () => {
    const bracelet = await makeBraceletWithCost("4000000"); // cost basis: 4,000,000 Rial/gram
    await goldPricesService.recordGoldPrice({ businessId: biz.id, purity: "18", pricePerGram: 5_000_000 });

    const client = await dbLib.getPool().connect();
    let result: Awaited<ReturnType<typeof goldSalesService.sellWeightedItem>>;
    try {
      await client.query("BEGIN");
      result = await goldSalesService.sellWeightedItem(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        itemId: bracelet.id,
        makingCharge: { type: "percent", value: 7 },
        profitPercent: 10,
        vatPercent: 9,
        paymentMethod: "cash",
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    // metalValue = 2.5 * 5,000,000 = 12,500,000; makingCharge = 875,000;
    // profit = 13,375,000 * 10% = 1,337,500; vat = (875,000+1,337,500)*9% = 199,125
    // total = 14,911,625
    expect(result.breakdown.total).toBe("14911625");
    expect(result.revenueEntryId).not.toBeNull();
    expect(result.cogsEntryId).not.toBeNull();

    const revenueLines = await db.query<{ account_id: string; debit: string; credit: string }>(
      "SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY debit DESC",
      [result.revenueEntryId],
    );
    expect(revenueLines.rows).toEqual([
      { account_id: acct.cash, debit: "14911625", credit: "0" },
      { account_id: acct.goldSalesRevenue, debit: "0", credit: "12500000" },
      { account_id: acct.makingChargeRevenue, debit: "0", credit: "2212500" },
      { account_id: acct.vatPayable, debit: "0", credit: "199125" },
    ]);

    // COGS = net weight (2.5) * unit cost (4,000,000) = 10,000,000
    const cogsLines = await db.query<{ account_id: string; debit: string; credit: string }>(
      "SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY debit DESC",
      [result.cogsEntryId],
    );
    expect(cogsLines.rows).toEqual([
      { account_id: acct.goldCogs, debit: "10000000", credit: "0" },
      { account_id: acct.goldInventory, debit: "0", credit: "10000000" },
    ]);

    const weightAttrs = await itemsService.getWeightAttributes(bracelet.id);
    expect(weightAttrs?.status).toBe("sold");

    const events = await db.query<{ event_type: string; entry_id: string | null }>(
      "SELECT event_type, entry_id FROM domain_events WHERE business_id = $1 ORDER BY event_type",
      [biz.id],
    );
    expect(events.rows).toHaveLength(2);
    expect(events.rows.every((r) => r.entry_id !== null)).toBe(true);
  });

  it("includes a stone's cost in COGS alongside the metal cost (Phase 21 Wave 4)", async () => {
    const ring = await makeBraceletWithCost("4000000"); // metal cost: 2.5g * 4,000,000 = 10,000,000
    await itemsService.addStone(ring.id, { stoneType: "الماس", carat: "0.5", cost: 3_000_000 });
    await goldPricesService.recordGoldPrice({ businessId: biz.id, purity: "18", pricePerGram: 5_000_000 });

    const client = await dbLib.getPool().connect();
    let result: Awaited<ReturnType<typeof goldSalesService.sellWeightedItem>>;
    try {
      await client.query("BEGIN");
      result = await goldSalesService.sellWeightedItem(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        itemId: ring.id,
        makingCharge: { type: "percent", value: 7 },
        profitPercent: 10,
        vatPercent: 9,
        paymentMethod: "cash",
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    // COGS = metal (10,000,000) + stone (3,000,000) = 13,000,000
    const cogsLines = await db.query<{ debit: string; credit: string }>(
      "SELECT debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY debit DESC",
      [result.cogsEntryId],
    );
    expect(cogsLines.rows).toEqual([
      { debit: "13000000", credit: "0" },
      { debit: "0", credit: "13000000" },
    ]);
  });

  it("refuses to sell the same piece twice", async () => {
    const bracelet = await makeBraceletWithCost("4000000");
    await goldPricesService.recordGoldPrice({ businessId: biz.id, purity: "18", pricePerGram: 5_000_000 });

    const sell = async () => {
      const client = await dbLib.getPool().connect();
      try {
        await client.query("BEGIN");
        await goldSalesService.sellWeightedItem(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          itemId: bracelet.id,
          makingCharge: { type: "percent", value: 7 },
          profitPercent: 10,
          vatPercent: 9,
          paymentMethod: "cash",
        });
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    };

    await sell();
    await expect(sell()).rejects.toThrow();
  });

  it("refuses to sell an item with no cost basis set", async () => {
    const item = await itemsService.createItem({
      locationId: biz.locationId,
      name: "گردنبند",
      tracking: "weight",
    });
    await itemsService.setWeightAttributes(item.id, { purity: "18", grossWeight: "1", netWeight: "1" });
    await goldPricesService.recordGoldPrice({ businessId: biz.id, purity: "18", pricePerGram: 5_000_000 });

    const client = await dbLib.getPool().connect();
    try {
      await client.query("BEGIN");
      await expect(
        goldSalesService.sellWeightedItem(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          itemId: item.id,
          makingCharge: { type: "percent", value: 7 },
          profitPercent: 10,
          vatPercent: 9,
          paymentMethod: "cash",
        }),
      ).rejects.toThrow();
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });

  it("refuses to sell when no price has been entered for the item's purity", async () => {
    const bracelet = await makeBraceletWithCost("4000000");
    // No recordGoldPrice call for purity 18.

    const client = await dbLib.getPool().connect();
    try {
      await client.query("BEGIN");
      await expect(
        goldSalesService.sellWeightedItem(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          itemId: bracelet.id,
          makingCharge: { type: "percent", value: 7 },
          profitPercent: 10,
          vatPercent: 9,
          paymentMethod: "cash",
        }),
      ).rejects.toThrow();
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });
});
