/**
 * Case status transitions and the waiting accumulator.
 *
 * The pure SLA arithmetic is covered in `crm-case-sla.test.ts`. What needs a
 * database is the **accumulator**: `waiting_seconds` is a running total that
 * must be closed out every time a case leaves `waiting`, and the failure mode
 * is invisible from a single status column — a case that bounces between
 * waiting and active silently loses each earlier stretch and its SLA improves
 * every time it bounces.
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
let cases: typeof import("../src/lib/crm-case-service");

const biz = { id: "" };
const actor = { name: "مسئول پشتیبانی" };

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
  databaseName = `pos_casesla_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  cases = await import("../src/lib/crm-case-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const business = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, industry)
     VALUES ('پشتیبانی تست', $1, 'food_service') RETURNING id`,
    [`case-${randomUUID().slice(0, 8)}`],
  );
  biz.id = business.rows[0].id;
}, 180_000);

afterAll(async () => {
  await db?.end();
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  await db.query(`DELETE FROM crm_case_events WHERE business_id = $1`, [biz.id]);
  await db.query(`DELETE FROM crm_cases WHERE business_id = $1`, [biz.id]);
});

async function makeCase(priority = "normal", openedHoursAgo = 0): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO crm_cases (business_id, subject, status, priority, opened_at)
     VALUES ($1, 'مشکل سفارش', 'open', $2, now() - ($3 || ' hours')::interval)
     RETURNING id`,
    [biz.id, priority, String(openedHoursAgo)],
  );
  return rows[0].id;
}

async function readCase(id: string) {
  const { rows } = await db.query<{
    status: string;
    waiting_seconds: string;
    waiting_since: Date | null;
    first_response_at: Date | null;
    resolved_at: Date | null;
    closed_at: Date | null;
    reopened_count: number;
  }>(`SELECT * FROM crm_cases WHERE id = $1`, [id]);
  return rows[0];
}

describe("the waiting accumulator", () => {
  it("starts the clock when a case enters waiting", async () => {
    const id = await makeCase();
    await cases.setCaseStatus(biz.id, id, "waiting", actor);

    const row = await readCase(id);
    expect(row.status).toBe("waiting");
    expect(row.waiting_since).not.toBeNull();
    // Nothing accumulated yet — the stretch is still in flight.
    expect(Number(row.waiting_seconds)).toBe(0);
  });

  it("closes out the stretch on the way back to active", async () => {
    const id = await makeCase();
    await cases.setCaseStatus(biz.id, id, "waiting", actor);

    // Backdate the wait so there is something measurable to accumulate.
    await db.query(
      `UPDATE crm_cases SET waiting_since = now() - interval '3 hours' WHERE id = $1`,
      [id],
    );

    await cases.setCaseStatus(biz.id, id, "in_progress", actor);
    const row = await readCase(id);
    expect(Number(row.waiting_seconds)).toBeGreaterThanOrEqual(3 * 3600 - 5);
    expect(Number(row.waiting_seconds)).toBeLessThan(3 * 3600 + 60);
    // Cleared, so the next wait starts fresh rather than double-counting.
    expect(row.waiting_since).toBeNull();
  });

  it("accumulates across a case that bounces", async () => {
    // The bug this defends against: each new wait overwriting the last, so a
    // case that goes waiting → active → waiting → active keeps only the final
    // stretch, and its SLA gets better every time it bounces.
    const id = await makeCase();

    await cases.setCaseStatus(biz.id, id, "waiting", actor);
    await db.query(
      `UPDATE crm_cases SET waiting_since = now() - interval '2 hours' WHERE id = $1`,
      [id],
    );
    await cases.setCaseStatus(biz.id, id, "in_progress", actor);

    await cases.setCaseStatus(biz.id, id, "waiting", actor);
    await db.query(
      `UPDATE crm_cases SET waiting_since = now() - interval '4 hours' WHERE id = $1`,
      [id],
    );
    await cases.setCaseStatus(biz.id, id, "in_progress", actor);

    const row = await readCase(id);
    // Both stretches, not just the last one.
    expect(Number(row.waiting_seconds)).toBeGreaterThanOrEqual(6 * 3600 - 10);
    expect(Number(row.waiting_seconds)).toBeLessThan(6 * 3600 + 120);
  });

  it("does not count waiting time against the SLA", async () => {
    // An urgent case (4h target) open for 10 hours, 8 of them waiting on the
    // customer, is not breached.
    const id = await makeCase("urgent", 10);
    await cases.setCaseStatus(biz.id, id, "waiting", actor);
    await db.query(
      `UPDATE crm_cases SET waiting_since = now() - interval '8 hours' WHERE id = $1`,
      [id],
    );

    const summary = await cases.caseSlaSummary(biz.id);
    expect(summary.waitingOnCustomer).toBe(1);
    // Explicitly NOT counted as breached: the clock is paused, and reporting
    // it as late would blame the team for the customer's silence.
    expect(summary.breached).toBe(0);
  });

  it("does count the same overrun when nobody is waiting on the customer", async () => {
    const id = await makeCase("urgent", 10);
    await cases.setCaseStatus(biz.id, id, "in_progress", actor);
    // Undo the auto first-response stamp: this case is genuinely untouched.
    await db.query(`UPDATE crm_cases SET first_response_at = NULL WHERE id = $1`, [id]);

    const summary = await cases.caseSlaSummary(biz.id);
    expect(summary.breached).toBe(1);
    expect(summary.waitingOnCustomer).toBe(0);
  });
});

describe("first response is recorded once", () => {
  it("stamps on the first move off open and never moves it", async () => {
    const id = await makeCase("normal", 2);
    await cases.setCaseStatus(biz.id, id, "in_progress", actor);
    const first = await readCase(id);
    expect(first.first_response_at).not.toBeNull();

    await cases.setCaseStatus(biz.id, id, "waiting", actor);
    await cases.setCaseStatus(biz.id, id, "in_progress", actor);
    const later = await readCase(id);
    // Unmoved: "somebody acknowledged me" happened when it happened, and a
    // later reply does not rewrite that.
    expect(later.first_response_at?.getTime()).toBe(first.first_response_at?.getTime());
  });

  it("does not treat closing an untouched case as a response", async () => {
    // A case closed without anybody replying (a duplicate, say) did not get a
    // response, and recording one would flatter the median.
    const id = await makeCase();
    await cases.setCaseStatus(biz.id, id, "closed", actor);
    const row = await readCase(id);
    expect(row.first_response_at).toBeNull();
    expect(row.closed_at).not.toBeNull();
  });
});

describe("resolution and reopening", () => {
  it("stamps resolved_at and clears it on reopen", async () => {
    const id = await makeCase();
    await cases.setCaseStatus(biz.id, id, "resolved", actor);
    expect((await readCase(id)).resolved_at).not.toBeNull();

    await cases.setCaseStatus(biz.id, id, "open", actor);
    const reopened = await readCase(id);
    expect(reopened.resolved_at).toBeNull();
    // A reopened case is a distinct failure from a slow one, and counting them
    // is the only way that failure is visible at all.
    expect(reopened.reopened_count).toBe(1);
  });

  it("refuses a move to the status it is already in", async () => {
    const id = await makeCase();
    const result = await cases.setCaseStatus(biz.id, id, "open", actor);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("same_status");

    // And wrote no event: a no-op must not pad the history.
    const { rows } = await db.query(`SELECT 1 FROM crm_case_events WHERE case_id = $1`, [id]);
    expect(rows).toHaveLength(0);
  });

  it("rejects a status that is not in the vocabulary", async () => {
    const id = await makeCase();
    const result = await cases.setCaseStatus(biz.id, id, "escalated_to_ceo", actor);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_status");
  });
});

describe("every transition is recorded", () => {
  it("writes an event with both ends of the move", async () => {
    // Without the event the SLA history is unreconstructable, and there is no
    // repairing it afterwards — the information was simply never written down.
    const id = await makeCase();
    await cases.setCaseStatus(biz.id, id, "in_progress", actor, { comment: "تماس گرفتم" });

    const { rows } = await db.query<{
      kind: string;
      from_status: string;
      to_status: string;
      body: string;
      actor_name: string;
    }>(`SELECT * FROM crm_case_events WHERE case_id = $1`, [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("status_changed");
    expect(rows[0].from_status).toBe("open");
    expect(rows[0].to_status).toBe("in_progress");
    expect(rows[0].body).toBe("تماس گرفتم");
    expect(rows[0].actor_name).toBe(actor.name);
  });
});

describe("case numbers", () => {
  it("counts per business rather than globally", async () => {
    // A global sequence would leak one tenant's case volume to another — a
    // competitor reading «تیکت #۴۸۲۱» learns something they should not.
    const other = await db.query<{ id: string }>(
      `INSERT INTO businesses (name, slug, industry)
       VALUES ('کسب‌وکار دوم', $1, 'food_service') RETURNING id`,
      [`case2-${randomUUID().slice(0, 8)}`],
    );
    const otherId = other.rows[0].id;

    expect(await cases.nextCaseNumber(biz.id)).toBe(1);
    expect(await cases.nextCaseNumber(biz.id)).toBe(2);
    // The second business starts at 1, learning nothing about the first.
    expect(await cases.nextCaseNumber(otherId)).toBe(1);
    expect(await cases.nextCaseNumber(biz.id)).toBe(3);

    await db.query(`DELETE FROM crm_case_counters WHERE business_id = $1`, [otherId]);
    await db.query(`DELETE FROM businesses WHERE id = $1`, [otherId]);
  });
});
