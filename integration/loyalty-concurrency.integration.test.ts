/**
 * `redeemPoints`/`useStoreCredit` check a balance that is a SUM over an
 * append-only ledger (`customer_points`, `domain_events`) rather than a
 * single row, so there was nothing for `SELECT ... FOR UPDATE` to lock: two
 * concurrent redemptions could both read the same balance, both pass the
 * "enough points?" check, and both commit — over-redeeming a customer's
 * points/store credit. Each function now opens with a session-scoped
 * `pg_advisory_xact_lock` keyed on the customer, the same primitive
 * `order-lock.ts` and `webhook-ingest-service.ts` use elsewhere. This mirrors
 * `order-concurrency.integration.test.ts`'s two-connection pattern to prove a
 * second redemption actually blocks behind the first, rather than racing it.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { redeemPoints } from "../src/lib/loyalty-service";
import { runMigrations } from "../scripts/migrate";

const configuredUrl = process.env.DATABASE_URL;
if (!configuredUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName = "";
let databaseUrl = "";
let businessId = "";
let locationId = "";
let customerId = "";

function urlFor(database: string): string {
  const url = new URL(configuredUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  return urlFor("postgres");
}

async function connect(url = databaseUrl): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

async function backendPid(client: Client): Promise<number> {
  const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return result.rows[0].pid;
}

async function waitUntilBlocked(observer: Client, blockedPid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ waiting: boolean }>(
      `SELECT wait_event_type = 'Lock' AS waiting
         FROM pg_stat_activity WHERE pid = $1`,
      [blockedPid],
    );
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`client ${blockedPid} did not block on the loyalty customer lock`);
}

beforeEach(async () => {
  databaseName = `pos_loyalty_race_${randomUUID().replaceAll("-", "")}`;
  const admin = await connect(maintenanceUrl());
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  await admin.end();
  databaseUrl = urlFor(databaseName);
  await runMigrations({ databaseUrl, quiet: true });

  const seed = await connect();
  const fixture = await seed.query<{ business_id: string; location_id: string; customer_id: string }>(`
    WITH business AS (
      INSERT INTO businesses(name) VALUES('Concurrency Test') RETURNING id
    ), location AS (
      INSERT INTO locations(business_id,name) SELECT id,'Main' FROM business RETURNING id
    ), customer AS (
      INSERT INTO parties(business_id,name) SELECT business.id,'مشتری' FROM business RETURNING id
    )
    SELECT business.id AS business_id, location.id AS location_id, customer.id AS customer_id
      FROM business CROSS JOIN location CROSS JOIN customer
  `);
  ({ business_id: businessId, location_id: locationId, customer_id: customerId } = fixture.rows[0]);

  // Accounts redeemPoints's store-credit posting rule needs, and one active
  // default loyalty program — same fixture shape as loyalty.integration.test.ts.
  await seed.query(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '4400', 'Sales Returns', 'revenue'),
            ($1, '2410', 'Store Credit Payable', 'liability')`,
    [businessId],
  );
  await seed.query(
    `INSERT INTO loyalty_programs (business_id, name, earn_points_per_100000, point_value_rial, is_default)
     VALUES ($1, 'پیش‌فرض', 1, 1000, true)`,
    [businessId],
  );
  // The customer has exactly 100 points — enough for one redemption of 100,
  // never two.
  await seed.query(
    `INSERT INTO customer_points (business_id, customer_id, points, source_type)
     VALUES ($1, $2, 100, 'test')`,
    [businessId, customerId],
  );
  await seed.end();
});

afterEach(async () => {
  if (!databaseName) return;
  const admin = await connect(maintenanceUrl());
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.end();
});

describe("loyalty points redemption serialization", () => {
  it("blocks a second full-balance redemption until the first commits, then refuses it", async () => {
    const first = await connect();
    const second = await connect();
    const observer = await connect();

    await first.query("BEGIN");
    const firstResult = await redeemPoints(first as never, {
      businessId,
      locationId,
      customerId,
      points: 100,
    });
    expect(firstResult.points).toBe(100);

    await second.query("BEGIN");
    const secondPid = await backendPid(second);

    // The rejection handler is attached *here*, at the moment the promise is
    // created, rather than at the `await` further down. This redemption is
    // meant to fail, but it only becomes awaited after `waitUntilBlocked` and
    // the COMMIT below — and if it rejects during that window with no handler
    // attached, Node raises an unhandledRejection. Vitest reports that as an
    // "Unhandled Error" and exits non-zero *even though every test passed*,
    // which is exactly how it surfaced: a green suite with a red exit code,
    // only under the timing of a full parallel run and never in isolation.
    // Settling into a tagged result keeps the assertion identical while making
    // the rejection observed from the start.
    const secondOutcome = redeemPoints(second as never, {
      businessId,
      locationId,
      customerId,
      points: 100,
    }).then(
      (value) => ({ rejected: false as const, value }),
      (reason: unknown) => ({ rejected: true as const, reason }),
    );

    await waitUntilBlocked(observer, secondPid);

    // The second redemption is still blocked on the customer's advisory
    // lock — it has not yet read a balance, committed or otherwise.
    await first.query("COMMIT");

    // Only once the first transaction has committed does the second acquire
    // the lock, read the now-zero balance, and refuse.
    const outcome = await secondOutcome;
    expect(outcome.rejected, "the second redemption was allowed to over-redeem").toBe(true);
    expect(outcome.rejected ? String((outcome.reason as Error)?.message) : "").toMatch(/امتیاز/);
    await second.query("ROLLBACK");

    await Promise.all([first.end(), second.end()]);

    const balance = await observer.query<{ balance: string }>(
      "SELECT COALESCE(SUM(points),0)::text AS balance FROM customer_points WHERE customer_id = $1",
      [customerId],
    );
    // Exactly one redemption applied — the ledger nets to zero, never negative.
    expect(balance.rows[0].balance).toBe("0");
    await observer.end();
  });
});
