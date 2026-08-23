/**
 * Warehouse counting — barcodes for F&B raw ingredients.
 *
 * Covers the half of a scan-driven stock count that the existing count engine
 * could not do: turning a scanned code back into the ingredient it names. The
 * count itself (variance, costing, ledger) is Phase 6's and is already covered
 * by stock-count-corrections.integration.test.ts — nothing here re-tests it.
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
let barcodes: typeof import("../src/lib/inventory-item-barcodes-service");

const biz = { id: "", locationId: "" };

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
  databaseName = `pos_invbarcodes_${randomUUID().replaceAll("-", "")}`;

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
  barcodes = await import("../src/lib/inventory-item-barcodes-service");

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
  await db.query("DELETE FROM inventory_item_barcodes");
  await db.query("DELETE FROM inventory_items");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Cafe Anbar', $1, 'food_service') RETURNING id",
    [`fnb-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;
});

async function makeItem(name: string, unit = "kg", isActive = true): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO inventory_items (location_id, name, unit, is_active) VALUES ($1, $2, $3, $4) RETURNING id",
    [biz.locationId, name, unit, isActive],
  );
  return rows[0].id;
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

describe("assignBarcode", () => {
  it("mints a scannable internal code when the ingredient arrives without one", async () => {
    const itemId = await makeItem("دانه قهوه");
    const barcode = await barcodes.assignBarcode(itemId, {});

    expect(barcode.symbology).toBe("internal");
    // EAN-13 shaped with the GS1 in-store prefix, so any scanner reads it
    // with no configuration — the whole point of not inventing a format.
    expect(barcode.code).toMatch(/^2\d{12}$/);
  });

  it("accepts a supplier's printed EAN-13 unchanged", async () => {
    const itemId = await makeItem("شیر");
    // 6260100000001 — a valid EAN-13 (check digit 1, per checkDigitFor).
    const barcode = await barcodes.assignBarcode(itemId, { code: "6260100000001" });
    expect(barcode.code).toBe("6260100000001");
    expect(barcode.symbology).toBe("EAN13");
  });

  it("refuses a code already stuck to another ingredient at the branch", async () => {
    const first = await makeItem("شکر");
    const second = await makeItem("نمک");
    await barcodes.assignBarcode(first, { code: "6260100000001" });

    await expect(barcodes.assignBarcode(second, { code: "6260100000001" })).rejects.toThrow(
      /قبلاً در همین شعبه/,
    );
  });

  it("refuses a mistyped code whose check digit does not validate", async () => {
    const itemId = await makeItem("آرد");
    // The valid code is …001; …004 is the same payload with a slipped check
    // digit, which is exactly what a hand-typed code gets wrong.
    await expect(
      barcodes.assignBarcode(itemId, { code: "6260100000004", symbology: "EAN13" }),
    ).rejects.toThrow(/هم‌خوانی ندارد/);
  });
});

describe("lookupBarcode", () => {
  it("resolves a scan back to the ingredient, with the unit the count needs", async () => {
    const itemId = await makeItem("دانه قهوه", "g");
    const assigned = await barcodes.assignBarcode(itemId, {});

    const matches = await barcodes.lookupBarcode(biz.locationId, assigned.code);
    expect(matches).toHaveLength(1);
    expect(matches[0].inventoryItemId).toBe(itemId);
    expect(matches[0].itemName).toBe("دانه قهوه");
    expect(matches[0].unit).toBe("g");
  });

  it("folds Persian digits, so a code typed by hand scans the same as one read", async () => {
    const itemId = await makeItem("چای");
    const assigned = await barcodes.assignBarcode(itemId, { code: "6260100000001" });
    const persian = "۶۲۶۰۱۰۰۰۰۰۰۰۱";

    const matches = await barcodes.lookupBarcode(biz.locationId, persian);
    expect(matches).toHaveLength(1);
    expect(matches[0].code).toBe(assigned.code);
  });

  it("returns nothing for a code that names no ingredient here", async () => {
    expect(await barcodes.lookupBarcode(biz.locationId, "6260100000001")).toEqual([]);
  });

  it("does not resolve a code belonging to another branch", async () => {
    const itemId = await makeItem("روغن");
    const assigned = await barcodes.assignBarcode(itemId, {});

    const otherLoc = await db.query<{ id: string }>(
      "INSERT INTO locations (business_id, name) VALUES ($1, 'Second') RETURNING id",
      [biz.id],
    );
    expect(await barcodes.lookupBarcode(otherLoc.rows[0].id, assigned.code)).toEqual([]);
  });
});

describe("mintMissingBarcodes", () => {
  it("labels every unlabelled active ingredient in one pass", async () => {
    await makeItem("قهوه");
    await makeItem("شیر");
    await makeItem("شکر");

    const result = await withTransaction((client) =>
      barcodes.mintMissingBarcodes(client, biz.locationId),
    );
    expect(result.minted).toBe(3);

    // Every minted code is distinct and immediately resolvable.
    const codes = new Set(result.codes.map((c) => c.code));
    expect(codes.size).toBe(3);
    for (const c of result.codes) {
      const matches = await barcodes.lookupBarcode(biz.locationId, c.code);
      expect(matches[0]?.inventoryItemId).toBe(c.inventoryItemId);
    }
  });

  it("is a no-op on a second run, so an interrupted first run is simply repeated", async () => {
    await makeItem("قهوه");
    await makeItem("شیر");

    const first = await withTransaction((client) =>
      barcodes.mintMissingBarcodes(client, biz.locationId),
    );
    const second = await withTransaction((client) =>
      barcodes.mintMissingBarcodes(client, biz.locationId),
    );

    expect(first.minted).toBe(2);
    expect(second.minted).toBe(0);
  });

  it("leaves an existing supplier code alone rather than minting a second one", async () => {
    const itemId = await makeItem("شیر");
    await barcodes.assignBarcode(itemId, { code: "6260100000001" });

    const result = await withTransaction((client) =>
      barcodes.mintMissingBarcodes(client, biz.locationId),
    );

    expect(result.minted).toBe(0);
    expect(await barcodes.listBarcodes(itemId)).toHaveLength(1);
  });

  it("skips inactive ingredients — they are not counted, so they need no label", async () => {
    await makeItem("قهوه");
    await makeItem("ادویهٔ بازنشسته", "g", false);

    const result = await withTransaction((client) =>
      barcodes.mintMissingBarcodes(client, biz.locationId),
    );
    expect(result.minted).toBe(1);
  });
});

describe("listItemsWithoutBarcode", () => {
  it("is what the label run works from, and empties as codes are assigned", async () => {
    const coffee = await makeItem("قهوه");
    await makeItem("شیر");

    expect(await barcodes.listItemsWithoutBarcode(biz.locationId)).toHaveLength(2);
    await barcodes.assignBarcode(coffee, {});

    const pending = await barcodes.listItemsWithoutBarcode(biz.locationId);
    expect(pending).toHaveLength(1);
    expect(pending[0].name).toBe("شیر");
  });
});
