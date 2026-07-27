/**
 * Phase 17 — "RLS subplan cost on the hot order/inventory paths".
 *
 * Migration 0021's Shape 2 policy comment says the plain intent out loud:
 * `location_id IN (SELECT l.id FROM locations l WHERE l.business_id =
 * app_current_business())` was written that way "so the planner hashes it
 * into a single subplan per statement, where a per-row helper function would
 * be evaluated once per row on the hot order/inventory paths." That was a
 * design decision made without a test to hold it in place — a later change
 * (to the policy, to `locations`, to Postgres's own planner defaults) could
 * quietly turn it into a per-row re-evaluation and nothing would fail.
 *
 * This test proves it stays true against real data volume, not a handful of
 * seed rows a planner would happily sequential-scan regardless of RLS:
 *
 *  1. The hot table itself is still reached through an index for the
 *     query's own predicate — RLS's extra clause must not push the planner
 *     off the index it would have used anyway.
 *  2. Any plan node touching `locations` (the table the RLS subquery reads)
 *     runs with `Actual Loops = 1` — i.e. it was hashed/materialised once,
 *     not re-executed once per candidate row.
 *
 * Runs as the unprivileged app role (see tenant-isolation.integration.test.ts
 * for why: RLS is a silent no-op under a superuser/BYPASSRLS connection, and
 * this project's own stock docker-compose.yml makes `pos` a superuser).
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole } from "../scripts/create-app-role";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const APP_ROLE = "pos_perf_test_role";
const APP_PASSWORD = "perf-test-password";
const ORDER_COUNT = 5_000;
const STOCK_MOVEMENT_COUNT = 5_000;

let databaseName: string;
let ownerClient: Client;
let appClient: Client;

const bizA = { businessId: "", locationId: "" };
const bizB = { businessId: "", locationId: "" };
let inventoryItemId: string;

function urlFor(database: string, user?: { name: string; password: string }): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

interface PlanNode {
  "Node Type"?: string;
  "Relation Name"?: string;
  "Actual Loops"?: number;
  Plans?: PlanNode[];
  [key: string]: unknown;
}

/** Flattens a plan tree (including subplans and CTEs) into every node in it. */
function flattenPlan(node: PlanNode): PlanNode[] {
  const children = node.Plans ?? [];
  return [node, ...children.flatMap(flattenPlan)];
}

async function explain(sql: string, params: unknown[]): Promise<PlanNode[]> {
  const { rows } = await appClient.query<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(
    `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`,
    params,
  );
  return flattenPlan(rows[0]["QUERY PLAN"][0].Plan);
}

beforeAll(async () => {
  databaseName = `pos_perf_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  await createAppRole({ databaseUrl: urlFor(databaseName), roleName: APP_ROLE, password: APP_PASSWORD, quiet: true });

  ownerClient = new Client({ connectionString: urlFor(databaseName) });
  await ownerClient.connect();
  appClient = new Client({ connectionString: urlFor(databaseName, { name: APP_ROLE, password: APP_PASSWORD }) });
  await appClient.connect();

  const a = await ownerClient.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Perf Cafe A', $1) RETURNING id",
    [`perf-a-${randomUUID().slice(0, 8)}`],
  );
  bizA.businessId = a.rows[0].id;
  const locA = await ownerClient.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [bizA.businessId],
  );
  bizA.locationId = locA.rows[0].id;

  const b = await ownerClient.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Perf Cafe B', $1) RETURNING id",
    [`perf-b-${randomUUID().slice(0, 8)}`],
  );
  bizB.businessId = b.rows[0].id;
  const locB = await ownerClient.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [bizB.businessId],
  );
  bizB.locationId = locB.rows[0].id;

  // Enough rows that a planner choosing to ignore an index would show up as
  // a real cost, not a rounding error — a handful of seed rows would fit on
  // one page and Postgres would happily seq-scan them regardless of RLS.
  for (const loc of [bizA.locationId, bizB.locationId]) {
    await ownerClient.query(
      `INSERT INTO orders (location_id, order_number, type, status, total, opened_at)
       SELECT $1, gs, 'takeaway',
              (CASE WHEN gs % 5 = 0 THEN 'open' ELSE 'completed' END)::order_status,
              50000, now() - (gs || ' minutes')::interval
       FROM generate_series(1, $2) AS gs`,
      [loc, ORDER_COUNT],
    );
    // order_items can only be inserted against an 'open' order (a DB trigger
    // enforces it) — the ORDER_COUNT % 5 == 0 slice from above.
    await ownerClient.query(
      `INSERT INTO order_items (location_id, order_id, name_snapshot, unit_price, quantity, status)
       SELECT o.location_id, o.id, 'Perf Item', 50000, 1, 'pending'
       FROM orders o WHERE o.location_id = $1 AND o.status = 'open'`,
      [loc],
    );
  }

  // Fifty other businesses' worth of inventory items and stock movements —
  // without this, bizA's own rows would BE the whole table and a Seq Scan
  // would be the (correct) planner choice regardless of any index or RLS,
  // proving nothing. With it, bizA's slice is a small fraction of the table,
  // same as it would be in a real multi-tenant deployment.
  await ownerClient.query(
    `WITH noise_biz AS (
       INSERT INTO businesses (name, slug)
       SELECT 'Perf Noise ' || gs, 'perf-noise-' || gs || '-' || substr(md5(random()::text), 1, 8)
       FROM generate_series(1, 50) AS gs
       RETURNING id
     ), noise_loc AS (
       INSERT INTO locations (business_id, name)
       SELECT id, 'Main' FROM noise_biz
       RETURNING id
     ), noise_inv AS (
       INSERT INTO inventory_items (location_id, name, unit)
       SELECT noise_loc.id, 'Ingredient ' || i, 'kg'
       FROM noise_loc, generate_series(1, 20) AS i
       RETURNING id, location_id
     )
     INSERT INTO stock_movements (location_id, inventory_item_id, type, quantity, occurred_at)
     SELECT noise_inv.location_id, noise_inv.id, 'purchase', 1, now() - (m || ' minutes')::interval
     FROM noise_inv, generate_series(1, 10) AS m`,
  );

  // bizA itself gets 20 inventory items with the movement volume spread
  // across all of them (not piled onto one), so a query for one item's
  // movements is selective against bizA's own rows too, not just the table
  // as a whole.
  const invItems = await ownerClient.query<{ id: string }>(
    `INSERT INTO inventory_items (location_id, name, unit)
     SELECT $1, 'Perf Ingredient ' || i, 'kg' FROM generate_series(1, 20) AS i
     RETURNING id`,
    [bizA.locationId],
  );
  inventoryItemId = invItems.rows[0].id;
  await ownerClient.query(
    `INSERT INTO stock_movements (location_id, inventory_item_id, type, quantity, occurred_at)
     SELECT $1, (SELECT id FROM unnest($2::uuid[]) AS id OFFSET (gs % 20) LIMIT 1),
            'purchase', 1, now() - (gs || ' minutes')::interval
     FROM generate_series(1, $3) AS gs`,
    [bizA.locationId, invItems.rows.map((r) => r.id), STOCK_MOVEMENT_COUNT],
  );

  await ownerClient.query(
    "ANALYZE businesses, locations, orders, order_items, inventory_items, stock_movements",
  );

  await appClient.query("SELECT set_config('app.business_id', $1, false)", [bizA.businessId]);
  await appClient.query("SELECT set_config('app.rls_bypass', '', false)");
}, 120_000);

afterAll(async () => {
  await ownerClient?.end();
  await appClient?.end();

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

/** No node scanning `table` in `nodes` is a sequential scan of the whole table. */
function expectIndexed(nodes: PlanNode[], table: string) {
  const seqScan = nodes.find((n) => n["Node Type"] === "Seq Scan" && n["Relation Name"] === table);
  expect(seqScan, `expected an index-based scan of ${table}, got a Seq Scan`).toBeUndefined();
}

/** Every node reading `locations` (the RLS subquery's table) ran exactly once — hashed, not per-row. */
function expectLocationsSubqueryRanOnce(nodes: PlanNode[]) {
  const locationNodes = nodes.filter((n) => n["Relation Name"] === "locations");
  expect(locationNodes.length, "expected the RLS subquery to touch `locations` at least once").toBeGreaterThan(0);
  for (const node of locationNodes) {
    expect(node["Actual Loops"], `locations node ran ${node["Actual Loops"]} times, expected 1`).toBe(1);
  }
}

describe("RLS-scoped hot-path queries stay index-backed at scale", () => {
  it("orders: location + status lookup (dashboard/KDS list) uses an index, not a seq scan", async () => {
    const nodes = await explain("SELECT id FROM orders WHERE location_id = $1 AND status = 'open'", [
      bizA.locationId,
    ]);
    expectIndexed(nodes, "orders");
    expectLocationsSubqueryRanOnce(nodes);
  });

  it("order_items: location + status lookup uses an index, not a seq scan", async () => {
    const nodes = await explain("SELECT id FROM order_items WHERE location_id = $1 AND status = 'pending'", [
      bizA.locationId,
    ]);
    expectIndexed(nodes, "order_items");
    expectLocationsSubqueryRanOnce(nodes);
  });

  it("inventory_items: location listing uses an index, not a seq scan", async () => {
    const nodes = await explain("SELECT id FROM inventory_items WHERE location_id = $1", [bizA.locationId]);
    expectIndexed(nodes, "inventory_items");
    expectLocationsSubqueryRanOnce(nodes);
  });

  it("stock_movements: per-item quantity sum (consumeInventoryExact's hot query) uses an index, not a seq scan", async () => {
    const nodes = await explain(
      "SELECT COALESCE(sum(quantity),0) FROM stock_movements WHERE inventory_item_id = $1",
      [inventoryItemId],
    );
    expectIndexed(nodes, "stock_movements");
    expectLocationsSubqueryRanOnce(nodes);
  });

  it("a lock-by-id read (lockOpenOrder's FOR UPDATE) stays a primary-key lookup under RLS", async () => {
    const { rows } = await appClient.query<{ id: string }>(
      "SELECT id FROM orders WHERE location_id = $1 AND status = 'open' LIMIT 1",
      [bizA.locationId],
    );
    const nodes = await explain("SELECT id FROM orders WHERE id = $1 FOR UPDATE", [rows[0].id]);
    expectIndexed(nodes, "orders");
  });
});
