/**
 * "Closed this shift" on the orders screen, against a real database — both
 * halves are DB-touching (`branchShiftStartedAt` in shift-service.ts,
 * `listOrdersClosedSince` in order-read-service.ts) and so are not unit tested
 * directly, per repo convention.
 *
 * What GET /api/orders?scope=shift promises, and what this pins down:
 *   1. no shift open at the branch = no window, so nothing is listed — the
 *      "closed orders disappear once the shift ends" rule the screen is built
 *      around, rather than falling back to a date range;
 *   2. with a shift running, the branch's orders closed since it started are
 *      listed newest close first;
 *   3. voided orders are listed alongside completed ones — reviewing a shift is
 *      exactly when someone goes looking for them;
 *   4. an order closed before the shift started belongs to the previous shift
 *      and is not listed;
 *   5. two employees clocked in means the window starts at the earlier of them,
 *      so clocking in mid-service never hides what was closed beforehand;
 *   6. another branch's closed orders are never listed.
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
let orderRead: typeof import("../src/lib/order-read-service");
let shiftService: typeof import("../src/lib/shift-service");
let dbLib: typeof import("../src/lib/db");

let businessId = "";
let mainId = "";
let otherId = "";
let employeeId = "";
let orderNumber = 0;

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  return urlFor("postgres");
}

/** A user plus its employees row — employee_shifts.employee_id references employees (migration 0042). */
async function seedEmployee(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, pin_hash)
     VALUES ($1, 'cashier', 'نگار سلطانی', $2, 'x') RETURNING id`,
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

/** One order, closed (or left open when `closedAt` is null) the way the app closes it. */
async function insertOrder(
  locationId: string,
  opts: {
    openedAt: string;
    closedAt?: string | null;
    status?: "open" | "completed" | "voided";
    total?: number;
  },
): Promise<number> {
  orderNumber += 1;
  const number = orderNumber;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO orders (location_id, order_number, type, status, total, opened_at)
     VALUES ($1, $2, 'dine_in', 'open', $3, $4)
     RETURNING id`,
    [locationId, number, opts.total ?? 500_000, opts.openedAt],
  );
  if (opts.closedAt) {
    await db.query("UPDATE orders SET status = $2, closed_at = $3 WHERE id = $1", [
      rows[0].id,
      opts.status ?? "completed",
      opts.closedAt,
    ]);
  }
  return number;
}

/** The pair the route runs: the branch's shift window, then what closed inside it. */
async function closedThisShift(locationId: string): Promise<number[]> {
  return dbLib.withTenant(businessId, async () => {
    const startedAt = await shiftService.branchShiftStartedAt(locationId);
    if (!startedAt) return [];
    const rows = await orderRead.listOrdersClosedSince(locationId, startedAt);
    return rows.map((row) => Number((row as { order_number: string }).order_number));
  });
}

beforeAll(async () => {
  databaseName = `pos_shift_closed_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  orderRead = await import("../src/lib/order-read-service");
  shiftService = await import("../src/lib/shift-service");
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
  // Reopened first: the order_not_open guard (migration 0036) rejects deleting a
  // closed order's rows, including the cascade from businesses.
  await db.query("UPDATE orders SET status = 'open'");
  await db.query("DELETE FROM orders");
  await db.query("DELETE FROM businesses");
  orderNumber = 0;

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

describe("branchShiftStartedAt", () => {
  it("is null when the branch has no shift open", async () => {
    await insertShift(mainId, "2026-08-14T06:00:00Z", "2026-08-14T14:00:00Z");
    const startedAt = await dbLib.withTenant(businessId, () =>
      shiftService.branchShiftStartedAt(mainId),
    );
    expect(startedAt).toBeNull();
  });

  it("is the earliest still-open shift's start when several are clocked in", async () => {
    await insertShift(mainId, "2026-08-15T06:00:00Z", null);
    // One open shift per employee (idx_employee_shifts_employee_open), so the
    // later clock-in is a second employee.
    await insertShift(mainId, "2026-08-15T10:00:00Z", null, await seedEmployee());

    const startedAt = await dbLib.withTenant(businessId, () =>
      shiftService.branchShiftStartedAt(mainId),
    );
    expect(startedAt).toBe(new Date("2026-08-15T06:00:00Z").toISOString());
  });

  it("ignores another branch's open shift", async () => {
    await insertShift(otherId, "2026-08-15T06:00:00Z", null);
    const startedAt = await dbLib.withTenant(businessId, () =>
      shiftService.branchShiftStartedAt(mainId),
    );
    expect(startedAt).toBeNull();
  });
});

describe("orders closed during the branch's running shift", () => {
  it("lists nothing once the shift has ended", async () => {
    await insertShift(mainId, "2026-08-14T06:00:00Z", "2026-08-14T14:00:00Z");
    await insertOrder(mainId, {
      openedAt: "2026-08-14T08:00:00Z",
      closedAt: "2026-08-14T08:30:00Z",
    });

    expect(await closedThisShift(mainId)).toEqual([]);
  });

  it("lists the shift's closed orders, newest close first", async () => {
    await insertShift(mainId, "2026-08-15T06:00:00Z", null);
    const first = await insertOrder(mainId, {
      openedAt: "2026-08-15T07:00:00Z",
      closedAt: "2026-08-15T07:30:00Z",
    });
    const second = await insertOrder(mainId, {
      openedAt: "2026-08-15T09:00:00Z",
      closedAt: "2026-08-15T09:20:00Z",
    });

    expect(await closedThisShift(mainId)).toEqual([second, first]);
  });

  it("keeps voided orders and leaves open ones to the queue", async () => {
    await insertShift(mainId, "2026-08-15T06:00:00Z", null);
    const voided = await insertOrder(mainId, {
      openedAt: "2026-08-15T07:00:00Z",
      closedAt: "2026-08-15T07:10:00Z",
      status: "voided",
    });
    await insertOrder(mainId, { openedAt: "2026-08-15T08:00:00Z" });

    expect(await closedThisShift(mainId)).toEqual([voided]);
  });

  it("excludes an order closed before the shift started", async () => {
    await insertShift(mainId, "2026-08-15T06:00:00Z", null);
    await insertOrder(mainId, {
      openedAt: "2026-08-15T05:00:00Z",
      closedAt: "2026-08-15T05:59:00Z",
    });
    const inShift = await insertOrder(mainId, {
      openedAt: "2026-08-15T05:30:00Z",
      closedAt: "2026-08-15T06:00:00Z",
    });

    // An order opened before the shift but paid after it started is this
    // shift's, which is why the window is on closed_at rather than opened_at.
    expect(await closedThisShift(mainId)).toEqual([inShift]);
  });

  it("covers what a colleague closed before the later clock-in", async () => {
    await insertShift(mainId, "2026-08-15T06:00:00Z", null);
    await insertShift(mainId, "2026-08-15T10:00:00Z", null, await seedEmployee());
    const early = await insertOrder(mainId, {
      openedAt: "2026-08-15T07:00:00Z",
      closedAt: "2026-08-15T07:30:00Z",
    });

    expect(await closedThisShift(mainId)).toEqual([early]);
  });

  it("never lists another branch's closed orders", async () => {
    await insertShift(mainId, "2026-08-15T06:00:00Z", null);
    await insertOrder(otherId, {
      openedAt: "2026-08-15T07:00:00Z",
      closedAt: "2026-08-15T07:30:00Z",
    });

    expect(await closedThisShift(mainId)).toEqual([]);
  });
});
