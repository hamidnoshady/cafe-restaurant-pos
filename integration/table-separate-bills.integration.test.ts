/**
 * Two friends at one table, two separate bills — against a real database.
 *
 * The till now lets a cashier pick an *occupied* table (see `listSelectableTables`
 * in src/lib/pos-selection.ts, and «مهمان جدید روی این میز» on an order's
 * detail), because a second order on a seated table is a friend who wants their
 * own invoice. Nothing in the schema changed for that: `ensureSessionForTable`
 * joins the table's existing open session, so the *visit* stays one session
 * while each `orders` row stays one bill.
 *
 * What this pins down:
 *   1. a second dine-in order on a seated table is accepted, gets its own
 *      order number and its own total, and shares the table's one session;
 *   2. settling one bill leaves the other open — "fully separated" means the
 *      friend's order is untouched by their neighbour's payment;
 *   3. a table that `createOrder` genuinely refuses (cleaning / out of service)
 *      is still refused, and leaves no order behind.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let orderMutations: typeof import("../src/lib/order-mutations");
let orderReads: typeof import("../src/lib/order-read-service");

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

interface Shop {
  businessId: string;
  locationId: string;
  menuItemId: string;
  tableId: string;
}

async function createShop(): Promise<Shop> {
  const biz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    [`Split Test ${randomUUID().slice(0, 6)}`, `split-test-${randomUUID().slice(0, 8)}`],
  );
  const businessId = biz.rows[0].id;
  const loc = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [businessId],
  );
  const locationId = loc.rows[0].id;
  const category = await db.query<{ id: string }>(
    "INSERT INTO menu_categories (location_id, name) VALUES ($1, 'چای') RETURNING id",
    [locationId],
  );
  const item = await db.query<{ id: string }>(
    "INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1, $2, 'چای کوچک', 600000) RETURNING id",
    [locationId, category.rows[0].id],
  );
  const table = await db.query<{ id: string }>(
    "INSERT INTO dining_tables (location_id, name, capacity) VALUES ($1, 'میز ۱', 4) RETURNING id",
    [locationId],
  );
  return { businessId, locationId, menuItemId: item.rows[0].id, tableId: table.rows[0].id };
}

function dineIn(shop: Shop, quantity: number) {
  return dbLib.withTenant(shop.businessId, () =>
    orderMutations.createOrder({
      locationId: shop.locationId,
      type: "dine_in",
      tableId: shop.tableId,
      discount: { type: null },
      items: [{ menuItemId: shop.menuItemId, quantity }],
      openedBy: null,
    }),
  );
}

beforeAll(async () => {
  databaseName = `pos_splitbills_${randomUUID().replaceAll("-", "")}`;

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
  orderMutations = await import("../src/lib/order-mutations");
  orderReads = await import("../src/lib/order-read-service");

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

describe("a second order on an occupied table", () => {
  it("is its own bill on the table's one session", async () => {
    const shop = await createShop();

    const first = await dineIn(shop, 1);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // The first order seated the table; the friend arrives to a 'seated' one.
    const seated = await db.query<{ status: string }>(
      "SELECT status FROM dining_tables WHERE id = $1",
      [shop.tableId],
    );
    expect(seated.rows[0].status).toBe("seated");

    const second = await dineIn(shop, 3);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.id).not.toBe(first.data.id);

    const { rows } = await db.query<{
      id: string;
      order_number: string;
      table_session_id: string;
      total: string;
    }>(
      "SELECT id, order_number, table_session_id, total FROM orders WHERE table_id = $1 ORDER BY opened_at",
      [shop.tableId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].table_session_id).toBe(rows[1].table_session_id);
    expect(rows[0].order_number).not.toBe(rows[1].order_number);
    expect(Number(rows[0].total)).toBe(600_000);
    expect(Number(rows[1].total)).toBe(1_800_000);

    // One visit, not two: a second session on the same table would break the
    // table map and the session bill.
    const sessions = await db.query<{ count: string }>(
      "SELECT count(*) FROM table_sessions WHERE location_id = $1 AND status = 'open'",
      [shop.locationId],
    );
    expect(Number(sessions.rows[0].count)).toBe(1);
  });

  it("settles on its own, leaving the neighbour's bill open", async () => {
    const shop = await createShop();
    const mine = await dineIn(shop, 1);
    const theirs = await dineIn(shop, 2);
    expect(mine.ok && theirs.ok).toBe(true);
    if (!mine.ok || !theirs.ok) return;

    await db.query("UPDATE orders SET status = 'completed', closed_at = now() WHERE id = $1", [
      mine.data.id,
    ]);

    const open = await dbLib.withTenant(shop.businessId, () =>
      orderReads.listOrders(shop.locationId, { status: "open" }),
    );
    expect(open.map((o) => o.id)).toEqual([theirs.data.id]);
  });

  it("still refuses a table that is being cleaned", async () => {
    const shop = await createShop();
    await db.query("UPDATE dining_tables SET status = 'cleaning' WHERE id = $1", [shop.tableId]);

    const result = await dineIn(shop, 1);
    expect(result).toMatchObject({ ok: false, error: "table_unavailable", status: 409 });

    const { rows } = await db.query<{ count: string }>(
      "SELECT count(*) FROM orders WHERE location_id = $1",
      [shop.locationId],
    );
    expect(Number(rows[0].count)).toBe(0);
  });
});
