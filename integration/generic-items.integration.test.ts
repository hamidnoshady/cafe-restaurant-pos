/**
 * Phase 21 Wave 1 exit criterion (partial): the generic Item/Variant/Serial
 * primitive works end-to-end — a variant_parent's children carry their own
 * distinguishing attributes, a serial-tracked item's units have real
 * identity and a status lifecycle, and a business's chosen industry is
 * readable back exactly as stored. Cross-tenant isolation for the new
 * tables is proven generically by tenant-isolation.integration.test.ts
 * (it discovers every non-exempt table from pg_class), not re-proven here.
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
  databaseName = `pos_items_${randomUUID().replaceAll("-", "")}`;

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
  await db.query("DELETE FROM item_serials");
  await db.query("DELETE FROM item_variant_attributes");
  await db.query("DELETE FROM items");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string; industry: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Bijoux Co', $1) RETURNING id, industry",
    [`items-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;
  // Every business created before Phase 21 -- and any not given an explicit
  // industry -- is food_service by construction (the column's DEFAULT).
  expect(bizRow.rows[0].industry).toBe("food_service");

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;
});

describe("businesses.industry", () => {
  it("is set and read back exactly as chosen", async () => {
    const row = await db.query<{ id: string; industry: string }>(
      "INSERT INTO businesses (name, slug, industry) VALUES ('Gold Co', $1, 'jewelry') RETURNING id, industry",
      [`jewelry-${randomUUID().slice(0, 8)}`],
    );
    expect(row.rows[0].industry).toBe("jewelry");
  });

  it("rejects an unknown industry value at the database", async () => {
    await expect(
      db.query("INSERT INTO businesses (name, slug, industry) VALUES ('Bad Co', $1, 'bakery')", [
        `bad-${randomUUID().slice(0, 8)}`,
      ]),
    ).rejects.toThrow();
  });
});

describe("items-service: simple items", () => {
  it("creates and lists a simple item", async () => {
    const item = await itemsService.createItem({ locationId: biz.locationId, name: "زنجیر طلا" });
    expect(item.kind).toBe("simple");
    expect(item.tracking).toBe("none");

    const listed = await itemsService.listItems(biz.locationId);
    expect(listed.map((i) => i.id)).toContain(item.id);
  });

  it("refuses createItem for a variant_child (must go through createVariantChild)", async () => {
    await expect(
      itemsService.createItem({ locationId: biz.locationId, name: "x", kind: "variant_child" }),
    ).rejects.toThrow();
  });
});

describe("items-service: variant parent/child", () => {
  it("creates a variant parent with children carrying their own attributes", async () => {
    const parent = await itemsService.createItem({
      locationId: biz.locationId,
      name: "دستبند بدلیجات",
      kind: "variant_parent",
    });

    const red = await itemsService.createVariantChild(parent.id, biz.locationId, "قرمز - M", null, [
      { name: "رنگ", value: "قرمز" },
      { name: "سایز", value: "M" },
    ]);
    const blue = await itemsService.createVariantChild(parent.id, biz.locationId, "آبی - L", null, [
      { name: "رنگ", value: "آبی" },
      { name: "سایز", value: "L" },
    ]);

    expect(red.kind).toBe("variant_child");
    expect(red.parentItemId).toBe(parent.id);

    const children = await itemsService.listVariantChildren(parent.id);
    expect(children.map((c) => c.id).sort()).toEqual([blue.id, red.id].sort());

    const redAttrs = await itemsService.listVariantAttributes(red.id);
    expect(redAttrs.map((a) => [a.name, a.value]).sort()).toEqual([
      ["رنگ", "قرمز"],
      ["سایز", "M"],
    ]);
  });

  it("refuses a variant child with no attributes", async () => {
    const parent = await itemsService.createItem({
      locationId: biz.locationId,
      name: "دستبند",
      kind: "variant_parent",
    });
    await expect(
      itemsService.createVariantChild(parent.id, biz.locationId, "بی‌نام", null, []),
    ).rejects.toThrow();

    // Nothing partially committed: the failed attempt left no orphan item row.
    const children = await itemsService.listVariantChildren(parent.id);
    expect(children).toHaveLength(0);
  });
});

describe("items-service: serialized items", () => {
  it("registers a serial only on a tracking:'serial' item", async () => {
    const watch = await itemsService.createItem({
      locationId: biz.locationId,
      name: "ساعت رولکس",
      tracking: "serial",
    });
    const serial = await itemsService.addSerial(watch.id, "RLX-0001");
    expect(serial.status).toBe("in_stock");

    const list = await itemsService.listSerials(watch.id);
    expect(list.map((s) => s.serialNumber)).toEqual(["RLX-0001"]);
  });

  it("refuses a serial on a non-serial-tracked item", async () => {
    const simple = await itemsService.createItem({ locationId: biz.locationId, name: "زنجیر" });
    await expect(itemsService.addSerial(simple.id, "X-1")).rejects.toThrow();
  });

  it("enforces the serial status lifecycle: sold is terminal", async () => {
    const watch = await itemsService.createItem({
      locationId: biz.locationId,
      name: "ساعت",
      tracking: "serial",
    });
    const serial = await itemsService.addSerial(watch.id, "SN-1");

    await itemsService.setSerialStatus(serial.id, "reserved");
    const sold = await itemsService.setSerialStatus(serial.id, "sold");
    expect(sold.status).toBe("sold");

    await expect(itemsService.setSerialStatus(serial.id, "in_stock")).rejects.toThrow();
  });

  it("rejects a duplicate serial number on the same item", async () => {
    const watch = await itemsService.createItem({
      locationId: biz.locationId,
      name: "ساعت",
      tracking: "serial",
    });
    await itemsService.addSerial(watch.id, "DUP-1");
    await expect(itemsService.addSerial(watch.id, "DUP-1")).rejects.toThrow();
  });
});
