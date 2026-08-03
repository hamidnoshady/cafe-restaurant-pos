/**
 * Phase 21 Wave 1: the first real (non-test) posting rule registered against
 * the engine, proving the design works against a live account-lookup +
 * balanced-entry shape rather than only synthetic test rules.
 * "inventory.operational_posting" is meant to reproduce exactly what
 * ledger-service.ts's postExactOperationalInventoryEntry already posts for
 * the same inputs (that function itself is unchanged and still covered
 * directly by exact-operational-consumption.integration.test.ts) -- this
 * proves the two paths agree.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import type { RialText } from "../src/lib/inventory-exact";

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
const acct = { wasteExpense: "", inventory: "" };

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
  databaseName = `pos_fnb_posting_rules_${randomUUID().replaceAll("-", "")}`;

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
  await import("../src/lib/fnb-posting-rules");

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

afterEach(async () => {
  // fnb-posting-rules registers itself once at import time; leave it
  // registered (it's F&B's real rule, not a test fixture) but clean the data.
  await db.query("DELETE FROM domain_events");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
});

beforeEach(async () => {
  await db.query("DELETE FROM domain_events");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('FNB Posting Rules Co', $1) RETURNING id",
    [`fpr-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '5150', 'Waste Expense', 'expense'), ($1, '1300', 'Inventory', 'asset')
     RETURNING id, code`,
    [biz.id],
  );
  for (const row of accounts.rows) {
    if (row.code === "5150") acct.wasteExpense = row.id;
    if (row.code === "1300") acct.inventory = row.id;
  }
});

describe("inventory.operational_posting rule", () => {
  it("posts the same balanced Debit/Credit shape postExactOperationalInventoryEntry would, via the engine", async () => {
    const client = await dbLib.getPool().connect();
    let entryId: string | null;
    try {
      await client.query("BEGIN");
      ({ entryId } = await postingEngine.emitDomainEvent(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        eventType: "inventory.operational_posting",
        payload: {
          debitCode: "5150",
          creditCode: "1300",
          amount: "24000" as RialText,
          memo: "ضایعات",
          postingKind: "waste",
          inventoryEventId: null,
        },
        sourceType: "waste",
        sourceId: randomUUID(),
      }));
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    expect(entryId).not.toBeNull();

    const entry = await db.query<{ memo: string; posting_kind: string; source_type: string }>(
      "SELECT memo, posting_kind, source_type FROM journal_entries WHERE id = $1",
      [entryId],
    );
    expect(entry.rows[0]).toMatchObject({ memo: "ضایعات", posting_kind: "waste", source_type: "waste" });

    const lines = await db.query<{ account_id: string; debit: string; credit: string }>(
      "SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY debit DESC",
      [entryId],
    );
    expect(lines.rows).toEqual([
      { account_id: acct.wasteExpense, debit: "24000", credit: "0" },
      { account_id: acct.inventory, debit: "0", credit: "24000" },
    ]);

    const eventRow = await db.query<{ entry_id: string; event_type: string }>(
      "SELECT entry_id, event_type FROM domain_events WHERE business_id = $1",
      [biz.id],
    );
    expect(eventRow.rows[0]).toMatchObject({ entry_id: entryId, event_type: "inventory.operational_posting" });
  });

  it("produces a journal entry structurally identical to calling postExactOperationalInventoryEntry directly with the same inputs", async () => {
    const events = await db.query<{ id: string }>(
      `INSERT INTO inventory_events (business_id, location_id, event_type, source_type, source_id)
       VALUES ($1, $2, 'waste', 'waste', $3), ($1, $2, 'waste', 'waste', $4) RETURNING id`,
      [biz.id, biz.locationId, randomUUID(), randomUUID()],
    );
    const [directInventoryEventId, viaEngineInventoryEventId] = events.rows.map((r) => r.id);

    const directClient = await dbLib.getPool().connect();
    let directEntryId: string | null;
    try {
      await directClient.query("BEGIN");
      directEntryId = await ledgerService.postExactOperationalInventoryEntry(directClient, {
        businessId: biz.id,
        locationId: biz.locationId,
        sourceType: "waste",
        sourceId: randomUUID(),
        postingKind: "waste",
        memo: "ضایعات",
        createdBy: null,
        inventoryEventId: directInventoryEventId,
        debitCode: "5150",
        creditCode: "1300",
        amount: "9500" as RialText,
      });
      await directClient.query("COMMIT");
    } finally {
      directClient.release();
    }

    const viaEngineClient = await dbLib.getPool().connect();
    let viaEngineEntryId: string | null;
    try {
      await viaEngineClient.query("BEGIN");
      ({ entryId: viaEngineEntryId } = await postingEngine.emitDomainEvent(viaEngineClient, {
        businessId: biz.id,
        locationId: biz.locationId,
        eventType: "inventory.operational_posting",
        payload: {
          debitCode: "5150",
          creditCode: "1300",
          amount: "9500" as RialText,
          memo: "ضایعات",
          postingKind: "waste",
          inventoryEventId: viaEngineInventoryEventId,
        },
        sourceType: "waste",
        sourceId: randomUUID(),
      }));
      await viaEngineClient.query("COMMIT");
    } finally {
      viaEngineClient.release();
    }

    const [direct, viaEngine] = await Promise.all([
      db.query<{ debit: string; credit: string }>(
        "SELECT debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY debit DESC",
        [directEntryId],
      ),
      db.query<{ debit: string; credit: string }>(
        "SELECT debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY debit DESC",
        [viaEngineEntryId],
      ),
    ]);
    expect(viaEngine.rows).toEqual(direct.rows);
  });
});
