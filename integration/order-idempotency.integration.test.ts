/**
 * POST /api/orders had no idempotency protection: a network retry (a proxy
 * timeout, a browser retry after a lost response) or two near-simultaneous
 * submissions for the same cart created two separate orders for what the
 * cashier believed was one submission. The offline-queue replay path already
 * solved this shape of problem with sync_events.client_event_id; this pins
 * down the same contract on createOrder's `clientRequestId`, scoped per
 * location the way order_number already is.
 *
 * What this pins down:
 *   1. two `createOrder` calls with the same `clientRequestId` for the same
 *      location return the same order id, and only one row is inserted;
 *   2. the same `clientRequestId` reused for a *different* location is a
 *      distinct order — the uniqueness is per location, not global;
 *   3. omitting `clientRequestId` behaves exactly as before — repeated calls
 *      with no id each create their own order;
 *   4. two callers racing the same `clientRequestId` concurrently (the
 *      check-then-insert window) still converge on one order, not a crash.
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
    [`Idempotency Test ${randomUUID().slice(0, 6)}`, `idempotency-test-${randomUUID().slice(0, 8)}`],
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

function takeaway(shop: Shop, clientRequestId?: string | null) {
  return dbLib.withTenant(shop.businessId, () =>
    orderMutations.createOrder({
      locationId: shop.locationId,
      type: "takeaway",
      discount: { type: null },
      items: [{ menuItemId: shop.menuItemId, quantity: 1 }],
      openedBy: null,
      clientRequestId,
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
  databaseName = `pos_orderidempotency_${randomUUID().replaceAll("-", "")}`;

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

describe("createOrder idempotency", () => {
  it("returns the same order id for a repeated clientRequestId instead of inserting a second order", async () => {
    const shop = await createShop();
    const clientRequestId = randomUUID();

    const first = await takeaway(shop, clientRequestId);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await takeaway(shop, clientRequestId);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.data.id).toBe(first.data.id);
    expect(second.data.orderNumber).toBe(first.data.orderNumber);
    expect(await orderCount(shop.locationId)).toBe(1);
  });

  it("stores the client_request_id on the created order", async () => {
    const shop = await createShop();
    const clientRequestId = randomUUID();

    const result = await takeaway(shop, clientRequestId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { rows } = await db.query<{ client_request_id: string | null }>(
      "SELECT client_request_id FROM orders WHERE id = $1",
      [result.data.id],
    );
    expect(rows[0].client_request_id).toBe(clientRequestId);
  });

  it("treats the same clientRequestId at a different location as a distinct order", async () => {
    const shopA = await createShop();
    const shopB = await createShop();
    const clientRequestId = randomUUID();

    const orderA = await takeaway(shopA, clientRequestId);
    const orderB = await takeaway(shopB, clientRequestId);
    expect(orderA.ok).toBe(true);
    expect(orderB.ok).toBe(true);
    if (!orderA.ok || !orderB.ok) return;

    expect(orderA.data.id).not.toBe(orderB.data.id);
    expect(await orderCount(shopA.locationId)).toBe(1);
    expect(await orderCount(shopB.locationId)).toBe(1);
  });

  it("creates a separate order each time when no clientRequestId is given, as before", async () => {
    const shop = await createShop();

    const first = await takeaway(shop);
    const second = await takeaway(shop);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.data.id).not.toBe(first.data.id);
    expect(await orderCount(shop.locationId)).toBe(2);
  });

  it("converges on one order when two concurrent calls race the same clientRequestId", async () => {
    const shop = await createShop();
    const clientRequestId = randomUUID();

    const [a, b] = await Promise.all([
      takeaway(shop, clientRequestId),
      takeaway(shop, clientRequestId),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect(a.data.id).toBe(b.data.id);
    expect(await orderCount(shop.locationId)).toBe(1);
  });
});
