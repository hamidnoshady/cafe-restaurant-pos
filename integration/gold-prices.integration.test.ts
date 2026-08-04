/**
 * Phase 21 Wave 2: daily gold price entry. Manual entry is the baseline
 * (source defaults to 'manual'); `source: 'external'` exists for a later,
 * optional price-feed integration to record without a schema change, though
 * no provider is wired up in this wave. Proves the "today's price is a
 * single current fact, not a log" model: recording again for the same
 * (business, purity, date) replaces the previous value rather than adding a
 * second row.
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
let goldPricesService: typeof import("../src/lib/gold-prices-service");

const biz = { id: "" };

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
  databaseName = `pos_gold_prices_${randomUUID().replaceAll("-", "")}`;

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
  goldPricesService = await import("../src/lib/gold-prices-service");

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
  await db.query("DELETE FROM gold_prices");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Gold Co', $1, 'jewelry') RETURNING id",
    [`gold-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;
});

describe("recordGoldPrice / getGoldPrice", () => {
  it("records today's price and reads it back", async () => {
    await goldPricesService.recordGoldPrice({ businessId: biz.id, purity: "18", pricePerGram: 5_000_000 });

    const price = await goldPricesService.getGoldPrice(biz.id, "18");
    expect(price?.pricePerGram).toBe(5_000_000);
    expect(price?.source).toBe("manual");
  });

  it("replaces (does not duplicate) today's price when recorded again", async () => {
    await goldPricesService.recordGoldPrice({ businessId: biz.id, purity: "18", pricePerGram: 5_000_000 });
    await goldPricesService.recordGoldPrice({ businessId: biz.id, purity: "18", pricePerGram: 5_200_000 });

    const price = await goldPricesService.getGoldPrice(biz.id, "18");
    expect(price?.pricePerGram).toBe(5_200_000);

    const rows = await db.query("SELECT 1 FROM gold_prices WHERE business_id = $1 AND purity = '18'", [
      biz.id,
    ]);
    expect(rows.rows).toHaveLength(1);
  });

  it("keeps each purity's price independent", async () => {
    await goldPricesService.recordGoldPrice({ businessId: biz.id, purity: "18", pricePerGram: 5_000_000 });
    await goldPricesService.recordGoldPrice({ businessId: biz.id, purity: "24", pricePerGram: 6_500_000 });

    expect((await goldPricesService.getGoldPrice(biz.id, "18"))?.pricePerGram).toBe(5_000_000);
    expect((await goldPricesService.getGoldPrice(biz.id, "24"))?.pricePerGram).toBe(6_500_000);
  });

  it("falls back to the most recent earlier price when none was entered today", async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await goldPricesService.recordGoldPrice({
      businessId: biz.id,
      purity: "18",
      pricePerGram: 4_800_000,
      priceDate: yesterday,
    });

    const price = await goldPricesService.getGoldPrice(biz.id, "18");
    expect(price?.pricePerGram).toBe(4_800_000);
  });

  it("returns null when no price has ever been entered for a purity", async () => {
    expect(await goldPricesService.getGoldPrice(biz.id, "21")).toBeNull();
  });

  it("rejects an unknown purity", async () => {
    await expect(
      goldPricesService.recordGoldPrice({ businessId: biz.id, purity: "22", pricePerGram: 5_000_000 }),
    ).rejects.toThrow();
  });

  it("rejects a non-positive or fractional price", async () => {
    await expect(
      goldPricesService.recordGoldPrice({ businessId: biz.id, purity: "18", pricePerGram: 0 }),
    ).rejects.toThrow();
    await expect(
      goldPricesService.recordGoldPrice({ businessId: biz.id, purity: "18", pricePerGram: -5 }),
    ).rejects.toThrow();
  });

  it("records an external-source price when asked, without changing the default for manual entry", async () => {
    await goldPricesService.recordGoldPrice({
      businessId: biz.id,
      purity: "24",
      pricePerGram: 6_600_000,
      source: "external",
    });
    const price = await goldPricesService.getGoldPrice(biz.id, "24");
    expect(price?.source).toBe("external");
  });
});

describe("listCurrentGoldPrices", () => {
  it("returns the latest price per purity as of today", async () => {
    await goldPricesService.recordGoldPrice({ businessId: biz.id, purity: "18", pricePerGram: 5_000_000 });
    await goldPricesService.recordGoldPrice({ businessId: biz.id, purity: "21", pricePerGram: 5_800_000 });

    const board = await goldPricesService.listCurrentGoldPrices(biz.id);
    const byPurity = Object.fromEntries(board.map((p) => [p.purity, p.pricePerGram]));
    expect(byPurity).toEqual({ "18": 5_000_000, "21": 5_800_000 });
  });

  it("never mixes one business's prices into another's board", async () => {
    const other = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug, industry) VALUES ('Other Gold Co', $1, 'jewelry') RETURNING id",
      [`other-gold-${randomUUID().slice(0, 8)}`],
    );
    await goldPricesService.recordGoldPrice({ businessId: biz.id, purity: "18", pricePerGram: 5_000_000 });
    await goldPricesService.recordGoldPrice({
      businessId: other.rows[0].id,
      purity: "18",
      pricePerGram: 9_999_999,
    });

    const board = await goldPricesService.listCurrentGoldPrices(biz.id);
    expect(board).toHaveLength(1);
    expect(board[0].pricePerGram).toBe(5_000_000);
  });
});
