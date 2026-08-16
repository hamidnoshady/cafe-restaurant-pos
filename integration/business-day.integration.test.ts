/**
 * The business day (روز کاری) against a real database — the whole point of the
 * feature is a date rule that PostgreSQL evaluates, so nothing here can be
 * usefully unit tested (the arithmetic-free half is business-day.test.ts).
 *
 * What this pins down, using the case that motivated it — a café trading
 * 18:00 → 03:00, business day starting at 18:00:
 *   1. an order rung after local midnight keeps the *previous* date's business
 *      day, so one night's service is one report row instead of two;
 *   2. the reporting views agree with that, since they all derive their date
 *      from the same function;
 *   3. the orders screen's window covers the whole service across midnight,
 *      and does not reset at 00:00 the way the calendar day did;
 *   4. closing the day by hand at 03:00 empties that window immediately, and
 *      the next evening's service starts from zero;
 *   5. a closure expires on its own once the next business day begins, so
 *      nothing has to be cleaned up;
 *   6. reopening undoes a close taken by mistake;
 *   7. closures never move a sale between report rows — the 04:00 order after a
 *      03:00 close is still filed under the business day it was sold in;
 *   8. a branch that has configured no business day behaves exactly as it did
 *      before this feature existed, calendar day and open-shift widening
 *      included;
 *   9. the business day is per branch: configuring one leaves the other alone.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const TEHRAN = "Asia/Tehran";
/** 18:00 — the business day the example café works to. */
const SIX_PM = 18 * 60;

let databaseName: string;
let db: Client;

let businessDay: typeof import("../src/lib/business-day-service");
let orderRead: typeof import("../src/lib/order-read-service");
let shiftService: typeof import("../src/lib/shift-service");
let dbLib: typeof import("../src/lib/db");

let businessId = "";
let mainId = "";
let otherId = "";
let ownerId = "";
let orderNumber = 0;

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  return urlFor("postgres");
}

/** A Tehran wall-clock time as the instant it names — the same conversion the SQL does. */
async function tehran(local: string): Promise<Date> {
  const { rows } = await db.query<{ at: Date }>(
    "SELECT ($1::timestamp AT TIME ZONE $2) AS at",
    [local, TEHRAN],
  );
  return rows[0].at;
}

async function setStart(
  locationId: string,
  startMinutes: number | null,
): Promise<void> {
  await db.query(
    "UPDATE locations SET business_day_start_minutes = $2 WHERE id = $1",
    [locationId, startMinutes],
  );
}

async function insertOrder(
  locationId: string,
  closedAt: Date,
  total = 500_000,
): Promise<number> {
  orderNumber += 1;
  const number = orderNumber;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO orders (location_id, order_number, type, status, total, opened_at)
     VALUES ($1, $2, 'dine_in', 'open', $3, $4)
     RETURNING id`,
    [locationId, number, total, closedAt],
  );
  await db.query(
    "UPDATE orders SET status = 'completed', closed_at = $2, closed_by = $3 WHERE id = $1",
    [rows[0].id, closedAt, ownerId],
  );
  return number;
}

/** The pair the orders route runs: the branch's window, then what closed inside it. */
async function closedInWindow(locationId: string): Promise<number[]> {
  return dbLib.withTenant(businessId, async () => {
    const { since } = await shiftService.branchClosedOrdersWindow(locationId);
    const rows = await orderRead.listOrdersClosedSince(locationId, since);
    return rows.map((row) =>
      Number((row as { order_number: string }).order_number),
    );
  });
}

/** `v_sales_by_day` grouped the way a report reads it: business date → order count. */
async function salesByDay(locationId: string): Promise<Record<string, number>> {
  const { rows } = await db.query<{ sale_date: Date; order_count: string }>(
    "SELECT sale_date, order_count FROM v_sales_by_day WHERE location_id = $1 ORDER BY sale_date",
    [locationId],
  );
  return Object.fromEntries(
    rows.map((row) => [
      row.sale_date.toISOString().slice(0, 10),
      Number(row.order_count),
    ]),
  );
}

beforeAll(async () => {
  databaseName = `pos_business_day_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  businessDay = await import("../src/lib/business-day-service");
  orderRead = await import("../src/lib/order-read-service");
  shiftService = await import("../src/lib/shift-service");
  dbLib = await import("../src/lib/db");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib
    ?.getPool()
    .end()
    .catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(
      `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
    );
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
    `INSERT INTO locations (business_id, name, timezone)
     VALUES ($1, 'Main', $2), ($1, 'Other', $2)
     RETURNING id, name`,
    [businessId, TEHRAN],
  );
  mainId = locations.rows.find((row) => row.name === "Main")!.id;
  otherId = locations.rows.find((row) => row.name === "Other")!.id;

  const owner = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, password_hash)
     VALUES ($1, 'owner', 'مالک', $2, 'x') RETURNING id`,
    [businessId, `owner-${randomUUID().slice(0, 8)}@example.com`],
  );
  ownerId = owner.rows[0].id;
});

describe("the business-day date rule", () => {
  it("keeps an after-midnight sale on the business day it was sold in", async () => {
    await setStart(mainId, SIX_PM);
    const { rows } = await db.query<{
      evening: Date;
      small_hours: Date;
      next_evening: Date;
    }>(
      `SELECT app_business_date(($1::timestamp AT TIME ZONE $4), $4, $5) AS evening,
              app_business_date(($2::timestamp AT TIME ZONE $4), $4, $5) AS small_hours,
              app_business_date(($3::timestamp AT TIME ZONE $4), $4, $5) AS next_evening`,
      [
        "2026-08-16 20:00",
        "2026-08-17 01:30",
        "2026-08-17 19:00",
        TEHRAN,
        SIX_PM,
      ],
    );
    const day = (value: Date) => value.toISOString().slice(0, 10);
    expect(day(rows[0].evening)).toBe("2026-08-16");
    expect(day(rows[0].small_hours)).toBe("2026-08-16");
    expect(day(rows[0].next_evening)).toBe("2026-08-17");
  });

  it("is the calendar day, unchanged, for a branch that configured none", async () => {
    const { rows } = await db.query<{ configured: Date; plain: Date }>(
      `SELECT app_business_date(($1::timestamp AT TIME ZONE $2), $2, NULL) AS configured,
              (($1::timestamp AT TIME ZONE $2) AT TIME ZONE $2)::date       AS plain`,
      ["2026-08-17 01:30", TEHRAN],
    );
    expect(rows[0].configured.toISOString().slice(0, 10)).toBe(
      rows[0].plain.toISOString().slice(0, 10),
    );
  });

  it("files one 18:00→03:00 service as a single row in the reporting views", async () => {
    await setStart(mainId, SIX_PM);
    await insertOrder(mainId, await tehran("2026-08-16 20:00"));
    await insertOrder(mainId, await tehran("2026-08-16 23:45"));
    await insertOrder(mainId, await tehran("2026-08-17 02:30"));
    await insertOrder(mainId, await tehran("2026-08-17 19:00"));

    expect(await salesByDay(mainId)).toEqual({
      "2026-08-16": 3,
      "2026-08-17": 1,
    });
  });

  it("splits that same service in two when no business day is configured", async () => {
    await insertOrder(mainId, await tehran("2026-08-16 20:00"));
    await insertOrder(mainId, await tehran("2026-08-16 23:45"));
    await insertOrder(mainId, await tehran("2026-08-17 02:30"));

    expect(await salesByDay(mainId)).toEqual({
      "2026-08-16": 2,
      "2026-08-17": 1,
    });
  });

  it("re-buckets history when management changes the start time, without moving orders", async () => {
    await insertOrder(mainId, await tehran("2026-08-17 02:30"));
    expect(await salesByDay(mainId)).toEqual({ "2026-08-17": 1 });

    await setStart(mainId, SIX_PM);
    expect(await salesByDay(mainId)).toEqual({ "2026-08-16": 1 });

    const { rows } = await db.query<{ count: string }>(
      "SELECT count(*) FROM orders",
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it("is per branch — configuring one leaves the other on the calendar day", async () => {
    await setStart(mainId, SIX_PM);
    const closedAt = await tehran("2026-08-17 02:30");
    await insertOrder(mainId, closedAt);
    await insertOrder(otherId, closedAt);

    expect(await salesByDay(mainId)).toEqual({ "2026-08-16": 1 });
    expect(await salesByDay(otherId)).toEqual({ "2026-08-17": 1 });
  });
});

describe("the live window the dashboard and orders screen read", () => {
  /**
   * The window is anchored on `now()`, so these exercise it by placing orders
   * relative to the business day currently in progress rather than by freezing
   * a clock the database does not share.
   */
  async function currentWindow(locationId: string) {
    return dbLib.withTenant(businessId, () =>
      businessDay.getBusinessDayStatus(locationId),
    );
  }

  it("reports the day in progress, its bounds, and where counting starts", async () => {
    await setStart(mainId, SIX_PM);
    const status = (await currentWindow(mainId))!;

    expect(status.enabled).toBe(true);
    expect(status.startMinutes).toBe(SIX_PM);
    expect(status.manuallyClosed).toBe(false);
    expect(status.windowStart).toBe(status.scheduledStart);
    expect(
      Date.parse(status.scheduledEnd) - Date.parse(status.scheduledStart),
    ).toBe(24 * 60 * 60 * 1000);
    // now() is inside the day it reports.
    expect(Date.parse(status.scheduledStart)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(status.scheduledEnd)).toBeGreaterThan(Date.now());
  });

  it("keeps the whole service in the orders list across local midnight", async () => {
    await setStart(mainId, SIX_PM);
    const status = (await currentWindow(mainId))!;
    const dayStart = Date.parse(status.scheduledStart);

    // An order just after the day began, and one "later in the service".
    const early = await insertOrder(mainId, new Date(dayStart + 60_000));
    const later = await insertOrder(
      mainId,
      new Date(dayStart + 2 * 60 * 60 * 1000),
    );
    // One from the previous business day, which must not appear.
    await insertOrder(mainId, new Date(dayStart - 60 * 60 * 1000));

    expect((await closedInWindow(mainId)).sort()).toEqual(
      [early, later].sort(),
    );
  });

  it("empties the window the moment management closes the day", async () => {
    await setStart(mainId, SIX_PM);
    const status = (await currentWindow(mainId))!;
    await insertOrder(
      mainId,
      new Date(Date.parse(status.scheduledStart) + 60_000),
    );
    expect(await closedInWindow(mainId)).toHaveLength(1);

    const closed = await dbLib.withTenant(businessId, () =>
      businessDay.closeBusinessDay(mainId, businessId, ownerId),
    );
    expect(closed.manuallyClosed).toBe(true);
    expect(Date.parse(closed.windowStart)).toBeGreaterThan(
      Date.parse(closed.scheduledStart),
    );
    expect(await closedInWindow(mainId)).toEqual([]);
  });

  it("counts what is sold after an early close into the fresh window", async () => {
    await setStart(mainId, SIX_PM);
    const closed = await dbLib.withTenant(businessId, () =>
      businessDay.closeBusinessDay(mainId, businessId, ownerId),
    );
    const afterClose = await insertOrder(
      mainId,
      new Date(Date.parse(closed.windowStart) + 60_000),
    );

    expect(await closedInWindow(mainId)).toEqual([afterClose]);
  });

  it("still files that post-close sale under the business day it happened in", async () => {
    await setStart(mainId, SIX_PM);
    const status = (await currentWindow(mainId))!;
    await dbLib.withTenant(businessId, () =>
      businessDay.closeBusinessDay(mainId, businessId, ownerId),
    );
    await insertOrder(mainId, new Date(Date.now() + 1_000));

    // Closing the day moves what is on screen, never what a report totals.
    expect(await salesByDay(mainId)).toEqual({ [status.businessDate]: 1 });
  });

  it("refuses a second close, and reopening restores the scheduled start", async () => {
    await setStart(mainId, SIX_PM);
    await dbLib.withTenant(businessId, () =>
      businessDay.closeBusinessDay(mainId, businessId, ownerId),
    );
    await expect(
      dbLib.withTenant(businessId, () =>
        businessDay.closeBusinessDay(mainId, businessId, ownerId),
      ),
    ).rejects.toThrow("business_day_already_closed");

    const reopened = await dbLib.withTenant(businessId, () =>
      businessDay.reopenBusinessDay(mainId, businessId, ownerId),
    );
    expect(reopened.manuallyClosed).toBe(false);
    expect(reopened.windowStart).toBe(reopened.scheduledStart);
  });

  it("lets a closure expire on its own once the next business day starts", async () => {
    await setStart(mainId, SIX_PM);
    const status = (await currentWindow(mainId))!;
    // A close recorded during the *previous* business day: still on file, but
    // it no longer holds the window, so nothing needs cleaning up.
    await db.query(
      `INSERT INTO business_day_closures (business_id, location_id, business_date, closed_at, closed_by)
       VALUES ($1, $2, $3::date - 1, $4::timestamptz - interval '1 day', $5)`,
      [businessId, mainId, status.businessDate, status.scheduledStart, ownerId],
    );

    const now = (await currentWindow(mainId))!;
    expect(now.manuallyClosed).toBe(false);
    expect(now.windowStart).toBe(now.scheduledStart);
    expect(now.lastClosedAt).not.toBeNull();
  });

  it("refuses to close a day for a branch that has configured none", async () => {
    await expect(
      dbLib.withTenant(businessId, () =>
        businessDay.closeBusinessDay(mainId, businessId, ownerId),
      ),
    ).rejects.toThrow("business_day_not_configured");
  });

  it("leaves an unconfigured branch on the calendar day, open shift widening included", async () => {
    const status = (await currentWindow(mainId))!;
    expect(status.enabled).toBe(false);

    // Local midnight, which is what the window used to (and must still) anchor on.
    const { rows } = await db.query<{ at: Date }>(
      "SELECT date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1 AS at",
      [TEHRAN],
    );
    expect(status.windowStart).toBe(rows[0].at.toISOString());

    const window = await dbLib.withTenant(businessId, () =>
      shiftService.branchClosedOrdersWindow(mainId),
    );
    expect(window.since).toBe(rows[0].at.toISOString());
    expect(window.businessDay).toBeNull();
  });
});
