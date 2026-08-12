/**
 * Shift-order review (the reports tab's "سفارش‌های شیفت"), against a real
 * database — shift-orders-service.ts joins orders/order_items and is not unit
 * tested directly, per repo convention; the grouping rule it delegates to is
 * covered by src/lib/shift-orders.test.ts.
 *
 * What the picker promises, and what this pins down:
 *   1. with no shift named, the report is the branch's *current* (newest)
 *      shift — the behaviour that existed before the picker;
 *   2. an earlier shift can be named, and reports its own orders, not the
 *      current one's;
 *   3. `shifts` carries the branch's shifts newest-first, so the dropdown has
 *      options to render and always contains the selected one;
 *   4. a shift belonging to *another branch* reports nothing rather than
 *      leaking that branch's orders — the isolation the route relies on
 *      instead of re-validating the id itself;
 *   5. window edges: an order opened before the shift started, or after it
 *      ended, is not the shift's.
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

/** Imported after DATABASE_URL is pointed at the scratch DB. */
let shiftOrders: typeof import("../src/lib/shift-orders-service");
let dbLib: typeof import("../src/lib/db");

let businessId = "";
let mainId = "";
let otherId = "";
let employeeId = "";

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

/**
 * A user plus its employees row — a shift's employee_id references employees,
 * which shares the users row's id (migration 0042), while the report's
 * employeeName still comes from users.full_name.
 */
async function seedEmployee(): Promise<string> {
  // An active member must carry some credential (users_credentials, migration
  // 0022); the report only ever reads full_name off this row.
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, pin_hash)
     VALUES ($1, 'manager', 'شیدا کاشانی', $2, 'x') RETURNING id`,
    [businessId, `cashier-${randomUUID().slice(0, 8)}@example.com`],
  );
  const id = rows[0].id;
  await db.query("INSERT INTO employees (id, business_id) VALUES ($1, $2)", [id, businessId]);
  return id;
}

async function insertShift(
  locationId: string,
  startedAt: string,
  endedAt: string | null,
  employee = employeeId,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO employee_shifts
       (employee_id, business_id, location_id, business_date, started_at, ended_at)
     VALUES ($1, $2, $3, $4::timestamptz::date, $4, $5)
     RETURNING id`,
    [employee, businessId, locationId, startedAt, endedAt],
  );
  return rows[0].id;
}

/** One order with a single line, opened at `openedAt`. Returns its id. */
async function insertOrder(
  locationId: string,
  openedAt: string,
  opts: { orderNumber: number; total: number; itemName: string; quantity?: number; unitPrice?: number },
): Promise<string> {
  // orders/order_items scope by location_id, not business_id (migration 0001).
  // Lines may only be added while the order is still open (the order_not_open
  // guard, migration 0036), so close it afterwards the way the app does.
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO orders (location_id, order_number, type, status, total, opened_at)
     VALUES ($1, $2, 'dine_in', 'open', $3, $4)
     RETURNING id`,
    [locationId, opts.orderNumber, opts.total, openedAt],
  );
  const orderId = rows[0].id;
  await db.query(
    `INSERT INTO order_items (location_id, order_id, name_snapshot, quantity, unit_price, status)
     VALUES ($1, $2, $3, $4, $5, 'served')`,
    [locationId, orderId, opts.itemName, opts.quantity ?? 1, opts.unitPrice ?? opts.total],
  );
  await db.query("UPDATE orders SET status = 'completed', closed_at = $2 WHERE id = $1", [orderId, openedAt]);
  return orderId;
}

beforeAll(async () => {
  databaseName = `pos_shift_orders_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  shiftOrders = await import("../src/lib/shift-orders-service");
  dbLib = await import("../src/lib/db");

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
  // Orders go first, reopened: the order_not_open guard (migration 0036) rejects
  // deleting a closed order's lines, including the cascade from businesses.
  await db.query("UPDATE orders SET status = 'open'");
  await db.query("DELETE FROM order_items");
  await db.query("DELETE FROM orders");
  await db.query("DELETE FROM businesses");

  const biz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Cafe', $1) RETURNING id",
    [`cafe-${randomUUID().slice(0, 8)}`],
  );
  businessId = biz.rows[0].id;

  const locations = await db.query<{ id: string; name: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'Main'), ($1, 'Other')
     RETURNING id, name`,
    [businessId],
  );
  mainId = locations.rows.find((r) => r.name === "Main")!.id;
  otherId = locations.rows.find((r) => r.name === "Other")!.id;

  employeeId = await seedEmployee();
});

/** Runs `fn` scoped to the business, the way an authenticated request would be. */
function asBusiness<T>(fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(businessId, fn);
}

describe("getShiftOrdersReport", () => {
  it("returns null for a branch that has never had a shift", async () => {
    const report = await asBusiness(() => shiftOrders.getShiftOrdersReport(mainId));
    expect(report).toBeNull();
  });

  it("defaults to the branch's current (newest) shift", async () => {
    await insertShift(mainId, "2026-08-10T06:00:00Z", "2026-08-10T14:00:00Z");
    const current = await insertShift(mainId, "2026-08-11T06:00:00Z", null);

    await insertOrder(mainId, "2026-08-10T08:00:00Z", {
      orderNumber: 1,
      total: 500_000,
      itemName: "چای",
    });
    await insertOrder(mainId, "2026-08-11T08:00:00Z", {
      orderNumber: 2,
      total: 900_000,
      itemName: "اسپرسو",
    });

    const report = await asBusiness(() => shiftOrders.getShiftOrdersReport(mainId));
    expect(report!.shift.id).toBe(current);
    expect(report!.orders.map((o) => o.orderNumber)).toEqual([2]);
    expect(report!.orders[0]!.lines.map((l) => l.name)).toEqual(["اسپرسو"]);
  });

  it("reports an earlier shift's own orders when one is named", async () => {
    const earlier = await insertShift(mainId, "2026-08-10T06:00:00Z", "2026-08-10T14:00:00Z");
    await insertShift(mainId, "2026-08-11T06:00:00Z", null);

    await insertOrder(mainId, "2026-08-10T08:00:00Z", {
      orderNumber: 1,
      total: 500_000,
      itemName: "چای",
    });
    await insertOrder(mainId, "2026-08-11T08:00:00Z", {
      orderNumber: 2,
      total: 900_000,
      itemName: "اسپرسو",
    });

    const report = await asBusiness(() => shiftOrders.getShiftOrdersReport(mainId, earlier));
    expect(report!.shift.id).toBe(earlier);
    expect(report!.orders.map((o) => o.orderNumber)).toEqual([1]);
  });

  it("carries the branch's shifts newest-first, including the selected one", async () => {
    const older = await insertShift(mainId, "2026-08-09T06:00:00Z", "2026-08-09T14:00:00Z");
    const middle = await insertShift(mainId, "2026-08-10T06:00:00Z", "2026-08-10T14:00:00Z");
    const newest = await insertShift(mainId, "2026-08-11T06:00:00Z", null);

    const report = await asBusiness(() => shiftOrders.getShiftOrdersReport(mainId, older));
    expect(report!.shifts.map((s) => s.id)).toEqual([newest, middle, older]);
    expect(report!.shifts.map((s) => s.id)).toContain(report!.shift.id);
    expect(report!.shifts[0]!.employeeName).toBe("شیدا کاشانی");
    // An open shift keeps a null end — the UI renders that as "در حال انجام".
    expect(report!.shifts[0]!.endedAt).toBeNull();
    expect(report!.shifts[1]!.endedAt).not.toBeNull();
  });

  it("reports nothing for a shift belonging to another branch", async () => {
    await insertShift(mainId, "2026-08-11T06:00:00Z", null);
    // An employee may only have one shift open at a time
    // (idx_employee_shifts_employee_open), so the other branch needs its own.
    const foreign = await insertShift(otherId, "2026-08-11T07:00:00Z", null, await seedEmployee());
    await insertOrder(otherId, "2026-08-11T08:00:00Z", {
      orderNumber: 9,
      total: 900_000,
      itemName: "کاپوچینو",
    });

    const report = await asBusiness(() => shiftOrders.getShiftOrdersReport(mainId, foreign));
    expect(report).toBeNull();
  });

  it("excludes orders opened outside the shift's window", async () => {
    const shift = await insertShift(mainId, "2026-08-10T06:00:00Z", "2026-08-10T14:00:00Z");
    await insertOrder(mainId, "2026-08-10T05:59:00Z", {
      orderNumber: 1,
      total: 100_000,
      itemName: "قبل از شیفت",
    });
    await insertOrder(mainId, "2026-08-10T09:00:00Z", {
      orderNumber: 2,
      total: 200_000,
      itemName: "در شیفت",
    });
    await insertOrder(mainId, "2026-08-10T14:01:00Z", {
      orderNumber: 3,
      total: 300_000,
      itemName: "بعد از شیفت",
    });

    const report = await asBusiness(() => shiftOrders.getShiftOrdersReport(mainId, shift));
    expect(report!.orders.map((o) => o.orderNumber)).toEqual([2]);
  });
});
