/**
 * Phase 21 Wave 1: the domain-event log + posting-rule engine that later
 * waves' industry modules register against, instead of each hand-writing a
 * new ledger-service.ts posting function the way every F&B event does today.
 * Proves the full loop: an event is recorded, a registered rule turns it
 * into a balanced journal entry via the same postJournalEntry() every
 * existing posting path uses, and the event is stamped with the entry it
 * produced -- while an event with no registered rule (or a rule that
 * declines to post) is recorded but left deliberately unposted, not an
 * error.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let ledgerService: typeof import("../src/lib/ledger-service");
let postingEngine: typeof import("../src/lib/posting-engine");

const biz = { id: "", locationId: "" };
const acct = { cash: "", revenue: "" };

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
  databaseName = `pos_posting_engine_${randomUUID().replaceAll("-", "")}`;

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
  ledgerService = await import("../src/lib/ledger-service");
  postingEngine = await import("../src/lib/posting-engine");

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

afterEach(() => {
  postingEngine.resetPostingRulesForTest();
});

beforeEach(async () => {
  await db.query("DELETE FROM domain_events");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Posting Engine Co', $1) RETURNING id",
    [`pe-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'), ($1, '4300', 'Sales', 'revenue')
     RETURNING id, code`,
    [biz.id],
  );
  for (const row of accounts.rows) {
    if (row.code === "1100") acct.cash = row.id;
    if (row.code === "4300") acct.revenue = row.id;
  }
});

describe("posting engine", () => {
  it("records and posts an event with a registered rule, stamping entry_id", async () => {
    postingEngine.registerPostingRule("test.sale", async (event) => {
      const amount = event.payload.amount as number;
      return {
        lines: [
          { accountId: acct.cash, debit: amount, credit: 0 },
          { accountId: acct.revenue, debit: 0, credit: amount },
        ],
      };
    });

    const client = await dbLib.getPool().connect();
    let entryId: string | null;
    try {
      await client.query("BEGIN");
      const result = await postingEngine.emitDomainEvent(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        eventType: "test.sale",
        payload: { amount: 150_000 },
        sourceType: "test",
      });
      entryId = result.entryId;
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    expect(entryId).not.toBeNull();

    const eventRow = await db.query<{ entry_id: string | null; event_type: string }>(
      "SELECT entry_id, event_type FROM domain_events WHERE business_id = $1",
      [biz.id],
    );
    expect(eventRow.rows).toHaveLength(1);
    expect(eventRow.rows[0].entry_id).toBe(entryId);

    const lines = await db.query<{ debit: string; credit: string }>(
      "SELECT debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY debit DESC",
      [entryId],
    );
    expect(lines.rows).toEqual([
      { debit: "150000", credit: "0" },
      { debit: "0", credit: "150000" },
    ]);
  });

  it("records an event with no registered rule and leaves it unposted", async () => {
    const client = await dbLib.getPool().connect();
    let entryId: string | null;
    try {
      await client.query("BEGIN");
      const result = await postingEngine.emitDomainEvent(client, {
        businessId: biz.id,
        eventType: "test.unregistered",
        payload: {},
      });
      entryId = result.entryId;
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    expect(entryId).toBeNull();
    const eventRow = await db.query<{ entry_id: string | null }>(
      "SELECT entry_id FROM domain_events WHERE business_id = $1",
      [biz.id],
    );
    expect(eventRow.rows[0].entry_id).toBeNull();

    const entries = await db.query("SELECT 1 FROM journal_entries WHERE business_id = $1", [biz.id]);
    expect(entries.rows).toHaveLength(0);
  });

  it("a rule that returns null posts nothing", async () => {
    postingEngine.registerPostingRule("test.informational", async () => null);

    const client = await dbLib.getPool().connect();
    try {
      await client.query("BEGIN");
      const { entryId } = await postingEngine.emitDomainEvent(client, {
        businessId: biz.id,
        eventType: "test.informational",
        payload: {},
      });
      expect(entryId).toBeNull();
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });

  it("an unbalanced rule's lines are rejected, matching every other posting path", async () => {
    postingEngine.registerPostingRule("test.unbalanced", async () => ({
      lines: [{ accountId: acct.cash, debit: 100, credit: 0 }],
    }));

    const client = await dbLib.getPool().connect();
    try {
      await client.query("BEGIN");
      await expect(
        postingEngine.emitDomainEvent(client, {
          businessId: biz.id,
          eventType: "test.unbalanced",
          payload: {},
        }),
      ).rejects.toThrow();
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });

  it("re-registering the same event type replaces the previous rule", async () => {
    postingEngine.registerPostingRule("test.replace", async () => ({
      lines: [
        { accountId: acct.cash, debit: 1, credit: 0 },
        { accountId: acct.revenue, debit: 0, credit: 1 },
      ],
    }));
    postingEngine.registerPostingRule("test.replace", async () => null);

    const client = await dbLib.getPool().connect();
    try {
      await client.query("BEGIN");
      const { entryId } = await postingEngine.emitDomainEvent(client, {
        businessId: biz.id,
        eventType: "test.replace",
        payload: {},
      });
      expect(entryId).toBeNull();
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });
});
