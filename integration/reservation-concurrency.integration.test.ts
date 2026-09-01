/**
 * Two staff members booking the same table at (almost) the same moment is a
 * classic check-then-act race: `tableConflicts` (a SELECT) and the INSERT
 * that follows it used to run with no lock between them, so two concurrent
 * requests could each see zero conflicts and both succeed — double-booking
 * the table. `lockTableForReservationWrite` closes that window with a
 * session-scoped advisory lock, the same primitive `order-lock.ts` and
 * `webhook-ingest-service.ts` already use elsewhere in this codebase. This
 * mirrors `order-concurrency.integration.test.ts`'s two-connection pattern to
 * prove the second writer actually blocks, then re-observes the first
 * writer's committed row instead of racing past it.
 */
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lockTableForReservationWrite, tableConflicts } from "../src/lib/reservation-service";
import { runMigrations } from "../scripts/migrate";

const configuredUrl = process.env.DATABASE_URL;
if (!configuredUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName = "";
let databaseUrl = "";
let locationId = "";
let tableId = "";

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
  throw new Error(`client ${blockedPid} did not block on the reservation table lock`);
}

const RESERVED_AT = "2026-09-10T18:00:00.000Z";
const DURATION_MINUTES = 90;

async function insertReservation(client: Client, name: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO reservations (location_id, table_id, customer_name, party_size, reserved_at, duration_minutes)
     VALUES ($1, $2, $3, 4, $4, $5) RETURNING id`,
    [locationId, tableId, name, RESERVED_AT, DURATION_MINUTES],
  );
  return rows[0].id;
}

beforeEach(async () => {
  databaseName = `pos_reservation_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = await connect(maintenanceUrl());
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  await admin.end();
  databaseUrl = urlFor(databaseName);
  await runMigrations({ databaseUrl, quiet: true });

  const seed = await connect();
  const fixture = await seed.query<{ location_id: string; table_id: string }>(`
    WITH business AS (
      INSERT INTO businesses(name) VALUES('Concurrency Test') RETURNING id
    ), location AS (
      INSERT INTO locations(business_id,name) SELECT id,'Main' FROM business RETURNING id
    ), new_table AS (
      INSERT INTO dining_tables(location_id,name,capacity)
      SELECT id,'T1',4 FROM location RETURNING id,location_id
    )
    SELECT location_id, id AS table_id FROM new_table
  `);
  ({ location_id: locationId, table_id: tableId } = fixture.rows[0]);
  await seed.end();
});

afterEach(async () => {
  if (!databaseName) return;
  const admin = await connect(maintenanceUrl());
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.end();
});

describe("reservation table-lock serialization", () => {
  it("blocks a second booking on the same table until the first commits, then sees it as a conflict", async () => {
    const first = await connect();
    const second = await connect();
    const observer = await connect();

    await first.query("BEGIN");
    await lockTableForReservationWrite(first as never, locationId, tableId);
    const conflictsForFirst = await tableConflicts(
      locationId,
      tableId,
      new Date(RESERVED_AT),
      DURATION_MINUTES,
      null,
      first as never,
    );
    expect(conflictsForFirst).toHaveLength(0);
    await insertReservation(first, "Reservation A");

    await second.query("BEGIN");
    const secondPid = await backendPid(second);
    const secondLock = lockTableForReservationWrite(second as never, locationId, tableId);
    await waitUntilBlocked(observer, secondPid);

    // The second writer is still blocked on the advisory lock — the table's
    // reservation is not yet visible to any check it could race ahead and run.
    await first.query("COMMIT");

    // Only once the first transaction has committed does the second acquire
    // the lock and get to run its own check — against the now-committed row.
    await secondLock;
    const conflictsForSecond = await tableConflicts(
      locationId,
      tableId,
      new Date(RESERVED_AT),
      DURATION_MINUTES,
      null,
      second as never,
    );
    expect(conflictsForSecond).toHaveLength(1);
    expect(conflictsForSecond[0].customer_name).toBe("Reservation A");
    await second.query("ROLLBACK");

    const { rows } = await observer.query<{ count: string }>("SELECT count(*)::text FROM reservations");
    expect(rows[0].count).toBe("1");

    await Promise.all([first.end(), second.end(), observer.end()]);
  });

  it("still allows a genuinely non-overlapping booking on the same table", async () => {
    const first = await connect();
    await first.query("BEGIN");
    await lockTableForReservationWrite(first as never, locationId, tableId);
    await insertReservation(first, "Lunch party");
    await first.query("COMMIT");
    await first.end();

    const second = await connect();
    await second.query("BEGIN");
    await lockTableForReservationWrite(second as never, locationId, tableId);
    const laterStart = new Date(new Date(RESERVED_AT).getTime() + DURATION_MINUTES * 60_000);
    const conflicts = await tableConflicts(locationId, tableId, laterStart, DURATION_MINUTES, null, second as never);
    expect(conflicts).toHaveLength(0);
    await insertReservation(second, "Dinner party");
    await second.query("COMMIT");
    await second.end();
  });
});
