/**
 * Attributing a till order to a customer, against a real database.
 *
 * The POS cart can now name a customer (the Select2-style picker in the cart
 * panel), which fills `orders.customer_id` — a column that until now only the
 * payment route wrote, after the sale. Customers are business-wide while
 * orders belong to a location, so the interesting part is the join between
 * those two scopes: createOrder validates the customer against the location's
 * *business*, and nothing else may slip through.
 *
 * What this pins down:
 *   1. a customer of the same business is stored on the order;
 *   2. omitting one leaves customer_id NULL — a walk-in sale stays anonymous;
 *   3. another business's customer is refused with `customer_not_found`, and
 *      no order row is left behind;
 *   4. an id that exists nowhere is refused the same way;
 *   5. and — the point of storing it at all — every order read hands the
 *      customer's *name* back, so the orders screen can show whose bill it is
 *      without a second round trip per row.
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
}

async function createShop(): Promise<Shop> {
  const biz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    [`Customer Test ${randomUUID().slice(0, 6)}`, `customer-test-${randomUUID().slice(0, 8)}`],
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
  return { businessId, locationId, menuItemId: item.rows[0].id };
}

async function createCustomer(businessId: string, name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO customers (business_id, name, phone) VALUES ($1, $2, '09120000000') RETURNING id",
    [businessId, name],
  );
  return rows[0].id;
}

function takeaway(shop: Shop, customerId?: string | null) {
  return dbLib.withTenant(shop.businessId, () =>
    orderMutations.createOrder({
      locationId: shop.locationId,
      type: "takeaway",
      customerId,
      discount: { type: null },
      items: [{ menuItemId: shop.menuItemId, quantity: 1 }],
      openedBy: null,
    }),
  );
}

async function orderCount(locationId: string): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    "SELECT count(*) FROM orders WHERE location_id = $1",
    [locationId],
  );
  return Number(rows[0].count);
}

beforeAll(async () => {
  databaseName = `pos_ordercustomer_${randomUUID().replaceAll("-", "")}`;

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

describe("orders created with a customer", () => {
  it("stores the business's own customer on the order", async () => {
    const shop = await createShop();
    const customerId = await createCustomer(shop.businessId, "مهسا رضایی");

    const result = await takeaway(shop, customerId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { rows } = await db.query<{ customer_id: string | null }>(
      "SELECT customer_id FROM orders WHERE id = $1",
      [result.data.id],
    );
    expect(rows[0].customer_id).toBe(customerId);
  });

  it("leaves customer_id NULL for a walk-in sale", async () => {
    const shop = await createShop();

    const result = await takeaway(shop);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { rows } = await db.query<{ customer_id: string | null }>(
      "SELECT customer_id FROM orders WHERE id = $1",
      [result.data.id],
    );
    expect(rows[0].customer_id).toBeNull();
  });

  it("refuses another business's customer and creates no order", async () => {
    const shop = await createShop();
    const neighbour = await createShop();
    const theirCustomer = await createCustomer(neighbour.businessId, "مشتری همسایه");

    const result = await takeaway(shop, theirCustomer);
    expect(result).toMatchObject({ ok: false, error: "customer_not_found", status: 404 });
    expect(await orderCount(shop.locationId)).toBe(0);
  });

  it("refuses an unknown customer id", async () => {
    const shop = await createShop();

    const result = await takeaway(shop, randomUUID());
    expect(result).toMatchObject({ ok: false, error: "customer_not_found", status: 404 });
    expect(await orderCount(shop.locationId)).toBe(0);
  });
});

/**
 * Storing `customer_id` is only half of it: the orders screen shows a name, not
 * a uuid, and it renders straight from these two reads. The join lives in
 * `ORDER_SUMMARY_SELECT`, shared by the open queue and the settled list, so one
 * missing column would blank the name on both at once.
 */
describe("order reads carry the customer's name", () => {
  it("names the customer on the open queue, the settled list and the detail", async () => {
    const shop = await createShop();
    const customerId = await createCustomer(shop.businessId, "مهسا رضایی");

    const result = await takeaway(shop, customerId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const open = await dbLib.withTenant(shop.businessId, () =>
      orderReads.listOrders(shop.locationId, { status: "open" }),
    );
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      customer_id: customerId,
      customer_name: "مهسا رضایی",
      customer_phone: "09120000000",
    });

    const detail = await dbLib.withTenant(shop.businessId, () =>
      orderReads.getOrderDetail(shop.locationId, result.data.id),
    );
    expect(detail?.order).toMatchObject({
      customer_name: "مهسا رضایی",
      customer_phone: "09120000000",
    });

    // Settle it, then read it back off the window the orders screen uses: the
    // name has to survive the move from the queue to the settled list.
    const closedAt = new Date();
    await db.query(
      "UPDATE orders SET status = 'completed', closed_at = $2 WHERE id = $1",
      [result.data.id, closedAt],
    );
    const settled = await dbLib.withTenant(shop.businessId, () =>
      orderReads.listSettledOrdersInWindow(shop.locationId, new Date(closedAt.getTime() - 60_000)),
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ customer_name: "مهسا رضایی" });
  });

  it("leaves the name null for a walk-in rather than dropping the row", async () => {
    const shop = await createShop();

    const result = await takeaway(shop);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const open = await dbLib.withTenant(shop.businessId, () =>
      orderReads.listOrders(shop.locationId, { status: "open" }),
    );
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ customer_id: null, customer_name: null });
  });
});
