/**
 * Physical stock counts (انبارگردانی) for the retail `items` model.
 *
 * The retail trades could receive, sell, transfer and write down stock but had
 * no way to record "we counted the shelf and it does not match". This covers
 * the count itself: what happens to `item_stock`, what posts to the ledger, and
 * what a reversal puts back.
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
let accessories: typeof import("../src/lib/accessories-service");
let counts: typeof import("../src/lib/item-stock-count-service");

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
  databaseName = `pos_itemcounts_${randomUUID().replaceAll("-", "")}`;

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
  accessories = await import("../src/lib/accessories-service");
  counts = await import("../src/lib/item-stock-count-service");

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
  await db.query("DELETE FROM item_stock_count_lines");
  await db.query("DELETE FROM item_stock_counts");
  await db.query("DELETE FROM item_stock");
  await db.query("DELETE FROM item_variant_attributes");
  await db.query("DELETE FROM domain_events");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM items");
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Bijoux Co', $1, 'accessories') RETURNING id",
    [`accessories-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;

  // 1340 accessory inventory, 5190 count shortage, 4910 count surplus — the
  // three the count rule resolves.
  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1340', 'Accessory Inventory', 'asset'),
            ($1, '5190', 'Count Shortage', 'expense'),
            ($1, '4910', 'Count Surplus', 'revenue')
     RETURNING id, code`,
    [biz.id],
  );
  for (const row of accounts.rows) acct[row.code] = row.id;
});

async function makeStockedItem(quantity: string, unitCost: number, name = "دستبند"): Promise<string> {
  const parent = await itemsService.createItem({
    locationId: biz.locationId,
    name: `${name} — خانواده`,
    kind: "variant_parent",
  });
  const child = await itemsService.createVariantChild(parent.id, biz.locationId, name, null, [
    { name: "رنگ", value: `طلایی-${randomUUID().slice(0, 4)}` },
  ]);
  if (Number(quantity) > 0) {
    await accessories.receiveStock(child.id, { quantity, unitCost });
  }
  return child.id;
}

async function withTransaction<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await dbLib.getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function linesOf(entryId: string) {
  const { rows } = await db.query<{ code: string; debit: string; credit: string }>(
    `SELECT a.code, l.debit::text, l.credit::text
       FROM journal_lines l JOIN accounts a ON a.id = l.account_id
      WHERE l.entry_id = $1 ORDER BY a.code`,
    [entryId],
  );
  return rows;
}

/** Debits and credits summed per account — the two-lines-per-account shape the
 *  variance entry uses (one side for the shortage, one for the surplus, exactly
 *  as postExactStockCountEntry does on the F&B side) has no inherent row order,
 *  so the assertion must not depend on one. */
async function totalsOf(entryId: string) {
  const { rows } = await db.query<{ code: string; debit: string; credit: string }>(
    `SELECT a.code, sum(l.debit)::text AS debit, sum(l.credit)::text AS credit
       FROM journal_lines l JOIN accounts a ON a.id = l.account_id
      WHERE l.entry_id = $1 GROUP BY a.code ORDER BY a.code`,
    [entryId],
  );
  return rows;
}

async function stockOf(itemId: string) {
  const { rows } = await db.query<{ quantity: string; unit_cost: string | null }>(
    "SELECT quantity::text, unit_cost::text FROM item_stock WHERE item_id = $1",
    [itemId],
  );
  return rows[0];
}

describe("createItemStockCount", () => {
  it("moves stock to the counted figure and books a shortage", async () => {
    const itemId = await makeStockedItem("10", 50_000);

    const result = await withTransaction((c) =>
      counts.createItemStockCount(c, {
        businessId: biz.id,
        locationId: biz.locationId,
        lines: [{ itemId, countedQty: "8" }],
        createdBy: null,
      }),
    );

    expect((await stockOf(itemId)).quantity).toBe("8.000000000");
    // Two missing at an average cost of 50,000.
    expect(result.shortage).toBe("100000");
    expect(result.surplus).toBe("0");

    expect(await linesOf(result.entryId!)).toEqual([
      { code: "1340", debit: "0", credit: "100000" },
      { code: "5190", debit: "100000", credit: "0" },
    ]);
  });

  it("books a surplus the other way round", async () => {
    const itemId = await makeStockedItem("10", 50_000);

    const result = await withTransaction((c) =>
      counts.createItemStockCount(c, {
        businessId: biz.id,
        locationId: biz.locationId,
        lines: [{ itemId, countedQty: "12" }],
        createdBy: null,
      }),
    );

    expect((await stockOf(itemId)).quantity).toBe("12.000000000");
    expect(result.surplus).toBe("100000");
    expect(await linesOf(result.entryId!)).toEqual([
      { code: "1340", debit: "100000", credit: "0" },
      { code: "4910", debit: "0", credit: "100000" },
    ]);
  });

  it("keeps a shortage and a surplus apart instead of netting them to nothing", async () => {
    const short = await makeStockedItem("10", 50_000, "کوتاه");
    const over = await makeStockedItem("10", 50_000, "زیاد");

    const result = await withTransaction((c) =>
      counts.createItemStockCount(c, {
        businessId: biz.id,
        locationId: biz.locationId,
        lines: [
          { itemId: short, countedQty: "8" },
          { itemId: over, countedQty: "12" },
        ],
        createdBy: null,
      }),
    );

    // Netting these would post nothing at all and hide both facts.
    expect(result.shortage).toBe("100000");
    expect(result.surplus).toBe("100000");
    // Inventory nets out across the two, but each side keeps its own account.
    expect(await totalsOf(result.entryId!)).toEqual([
      { code: "1340", debit: "100000", credit: "100000" },
      { code: "4910", debit: "0", credit: "100000" },
      { code: "5190", debit: "100000", credit: "0" },
    ]);
  });

  it("never changes the unit cost — only the quantity was wrong", async () => {
    const itemId = await makeStockedItem("10", 50_000);
    await withTransaction((c) =>
      counts.createItemStockCount(c, {
        businessId: biz.id,
        locationId: biz.locationId,
        lines: [{ itemId, countedQty: "3" }],
        createdBy: null,
      }),
    );
    expect((await stockOf(itemId)).unit_cost).toBe("50000");
  });

  it("records a line that matched, and posts no entry for a count with no variance", async () => {
    const itemId = await makeStockedItem("10", 50_000);

    const result = await withTransaction((c) =>
      counts.createItemStockCount(c, {
        businessId: biz.id,
        locationId: biz.locationId,
        lines: [{ itemId, countedQty: "10" }],
        createdBy: null,
      }),
    );

    expect(result.entryId).toBeNull();
    const detail = await withTransaction((c) =>
      counts.getItemStockCountDetail(c, { locationId: biz.locationId, countId: result.id }),
    );
    // "We counted this and it was right" is a different statement from
    // "we did not count this", so the line is kept.
    expect(detail?.lines).toHaveLength(1);
    expect(detail?.lines[0].variance).toBe("0");
  });

  it("corrects a quantity with no cost basis without inventing a value", async () => {
    const itemId = await makeStockedItem("0", 0);

    const result = await withTransaction((c) =>
      counts.createItemStockCount(c, {
        businessId: biz.id,
        locationId: biz.locationId,
        lines: [{ itemId, countedQty: "5" }],
        createdBy: null,
      }),
    );

    expect((await stockOf(itemId)).quantity).toBe("5.000000000");
    expect(result.surplus).toBe("0");
    expect(result.entryId).toBeNull();
  });

  it("counts a shelf down to zero", async () => {
    const itemId = await makeStockedItem("4", 25_000);
    const result = await withTransaction((c) =>
      counts.createItemStockCount(c, {
        businessId: biz.id,
        locationId: biz.locationId,
        lines: [{ itemId, countedQty: "0" }],
        createdBy: null,
      }),
    );
    expect((await stockOf(itemId)).quantity).toBe("0.000000000");
    expect(result.shortage).toBe("100000");
  });

  it("refuses a negative count, a malformed one, and the same item twice", async () => {
    const itemId = await makeStockedItem("5", 10_000);
    const attempt = (lines: { itemId: string; countedQty: string }[]) =>
      withTransaction((c) =>
        counts.createItemStockCount(c, {
          businessId: biz.id,
          locationId: biz.locationId,
          lines,
          createdBy: null,
        }),
      );

    await expect(attempt([{ itemId, countedQty: "-1" }])).rejects.toThrow("invalid_quantity");
    await expect(attempt([{ itemId, countedQty: "abc" }])).rejects.toThrow("invalid_quantity");
    await expect(
      attempt([
        { itemId, countedQty: "1" },
        { itemId, countedQty: "2" },
      ]),
    ).rejects.toThrow("duplicate_item");
  });

  it("refuses an item belonging to another branch", async () => {
    const itemId = await makeStockedItem("5", 10_000);
    const other = await db.query<{ id: string }>(
      "INSERT INTO locations (business_id, name) VALUES ($1, 'Second') RETURNING id",
      [biz.id],
    );

    await expect(
      withTransaction((c) =>
        counts.createItemStockCount(c, {
          businessId: biz.id,
          locationId: other.rows[0].id,
          lines: [{ itemId, countedQty: "5" }],
          createdBy: null,
        }),
      ),
    ).rejects.toThrow("item_not_found");
  });
});

describe("reverseItemStockCount", () => {
  it("puts the stock back and reverses the variance entry", async () => {
    const itemId = await makeStockedItem("10", 50_000);
    const count = await withTransaction((c) =>
      counts.createItemStockCount(c, {
        businessId: biz.id,
        locationId: biz.locationId,
        lines: [{ itemId, countedQty: "8" }],
        createdBy: null,
      }),
    );

    const reversal = await withTransaction((c) =>
      counts.reverseItemStockCount(c, {
        businessId: biz.id,
        locationId: biz.locationId,
        countId: count.id,
        createdBy: null,
      }),
    );

    expect((await stockOf(itemId)).quantity).toBe("10.000000000");
    // The mirror image of the original: inventory back up, expense given back.
    expect(await linesOf(reversal.entryId!)).toEqual([
      { code: "1340", debit: "100000", credit: "0" },
      { code: "5190", debit: "0", credit: "100000" },
    ]);
  });

  it("preserves sales made after the count rather than resetting to the old figure", async () => {
    const itemId = await makeStockedItem("10", 50_000);
    await withTransaction((c) =>
      counts.createItemStockCount(c, {
        businessId: biz.id,
        locationId: biz.locationId,
        lines: [{ itemId, countedQty: "8" }],
        createdBy: null,
      }),
    ).then((count) =>
      db
        .query("UPDATE item_stock SET quantity = quantity - 3 WHERE item_id = $1", [itemId])
        .then(() => count),
    ).then((count) =>
      withTransaction((c) =>
        counts.reverseItemStockCount(c, {
          businessId: biz.id,
          locationId: biz.locationId,
          countId: count.id,
          createdBy: null,
        }),
      ),
    );

    // 8 counted, 3 sold = 5; undoing a shortage of 2 gives 7, not the
    // pre-count 10 — the three sales still happened.
    expect((await stockOf(itemId)).quantity).toBe("7.000000000");
  });

  it("refuses when a counted surplus has since been sold", async () => {
    const itemId = await makeStockedItem("10", 50_000);
    const count = await withTransaction((c) =>
      counts.createItemStockCount(c, {
        businessId: biz.id,
        locationId: biz.locationId,
        lines: [{ itemId, countedQty: "14" }],
        createdBy: null,
      }),
    );
    await db.query("UPDATE item_stock SET quantity = 1 WHERE item_id = $1", [itemId]);

    await expect(
      withTransaction((c) =>
        counts.reverseItemStockCount(c, {
          businessId: biz.id,
          locationId: biz.locationId,
          countId: count.id,
          createdBy: null,
        }),
      ),
    ).rejects.toThrow("count_stock_consumed");
  });

  it("refuses a second reversal of the same count", async () => {
    const itemId = await makeStockedItem("10", 50_000);
    const count = await withTransaction((c) =>
      counts.createItemStockCount(c, {
        businessId: biz.id,
        locationId: biz.locationId,
        lines: [{ itemId, countedQty: "8" }],
        createdBy: null,
      }),
    );
    await withTransaction((c) =>
      counts.reverseItemStockCount(c, {
        businessId: biz.id,
        locationId: biz.locationId,
        countId: count.id,
        createdBy: null,
      }),
    );

    await expect(
      withTransaction((c) =>
        counts.reverseItemStockCount(c, {
          businessId: biz.id,
          locationId: biz.locationId,
          countId: count.id,
          createdBy: null,
        }),
      ),
    ).rejects.toThrow("already_reversed");
  });
});

describe("listItemStockCounts", () => {
  it("summarises each count and hides reversal rows as counts of their own", async () => {
    const itemId = await makeStockedItem("10", 50_000);
    const count = await withTransaction((c) =>
      counts.createItemStockCount(c, {
        businessId: biz.id,
        locationId: biz.locationId,
        lines: [{ itemId, countedQty: "8" }],
        createdBy: null,
      }),
    );

    let listed = await withTransaction((c) => counts.listItemStockCounts(c, biz.locationId));
    expect(listed).toHaveLength(1);
    expect(listed[0].shortageValue).toBe("100000");
    expect(listed[0].surplusValue).toBe("0");
    expect(listed[0].lineCount).toBe(1);
    expect(listed[0].reversed).toBe(false);

    await withTransaction((c) =>
      counts.reverseItemStockCount(c, {
        businessId: biz.id,
        locationId: biz.locationId,
        countId: count.id,
        createdBy: null,
      }),
    );

    listed = await withTransaction((c) => counts.listItemStockCounts(c, biz.locationId));
    expect(listed).toHaveLength(1);
    expect(listed[0].reversed).toBe(true);
  });
});
