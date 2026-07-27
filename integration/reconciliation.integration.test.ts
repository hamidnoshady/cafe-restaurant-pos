/**
 * Phase 16 scope: "Bank & cash reconciliation — ... match against cash /
 * bankClearing postings, carry unreconciled items, lock a reconciled
 * period." Proves the core mechanics against real posted entries: a
 * reconciliation's candidate lines are whatever hasn't been claimed by an
 * earlier *completed* reconciliation, completing one requires the cleared
 * total (plus the running opening balance) to exactly match the statement,
 * and completed lines can never be reused.
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
let dbLib: typeof import("../src/lib/db");
let reconciliationService: typeof import("../src/lib/reconciliation-service");

const biz = { id: "" };
const acct = { cash: "", bankClearing: "", revenue: "" };
const user = { id: "" };

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
  databaseName = `pos_reconcile_${randomUUID().replaceAll("-", "")}`;

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
  reconciliationService = await import("../src/lib/reconciliation-service");

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
  await db.query("DELETE FROM bank_reconciliation_lines");
  await db.query("DELETE FROM bank_reconciliations");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Reconcile Co', $1) RETURNING id",
    [`reconcile-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const userRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
    [biz.id],
  );
  user.id = userRow.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'), ($1, '1120', 'Card clearing', 'asset'), ($1, '4300', 'Sales', 'revenue')
     RETURNING id, code`,
    [biz.id],
  );
  for (const r of accounts.rows) {
    if (r.code === "1100") acct.cash = r.id;
    if (r.code === "1120") acct.bankClearing = r.id;
    if (r.code === "4300") acct.revenue = r.id;
  }
});

/** Posts a balanced two-line entry directly, mirroring an order cash sale. */
async function postCashEntry(entryDate: string, amount: number): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (business_id, entry_date, memo, source_type)
     VALUES ($1, $2, 'Order payment', 'order') RETURNING id`,
    [biz.id, entryDate],
  );
  const { rows: lineRows } = await db.query<{ id: string }>(
    `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $3, 0) RETURNING id`,
    [rows[0].id, acct.cash, amount],
  );
  await db.query(`INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, 0, $3)`, [
    rows[0].id,
    acct.revenue,
    amount,
  ]);
  return lineRows[0].id;
}

describe("createReconciliation", () => {
  it("rejects a second in-progress reconciliation for the same account", async () => {
    await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    await expect(
      reconciliationService.createReconciliation({
        businessId: biz.id,
        accountCode: "cash",
        statementDate: "2025-05-31",
        statementBalance: 200_000,
        createdBy: user.id,
      }),
    ).rejects.toThrow("reconciliation_in_progress");
  });

  it("allows concurrent in-progress reconciliations for different accounts", async () => {
    await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    await expect(
      reconciliationService.createReconciliation({
        businessId: biz.id,
        accountCode: "bankClearing",
        statementDate: "2025-04-30",
        statementBalance: 50_000,
        createdBy: user.id,
      }),
    ).resolves.toBeTruthy();
  });
});

describe("getReconciliation", () => {
  it("lists cash-account lines as uncleared candidates, excluding other accounts and later dates", async () => {
    const cashLineId = await postCashEntry("2025-04-10", 100_000);
    // A bank-clearing line and a later-dated cash line should not show up.
    await db.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit)
       SELECT id, $2, 50000, 0 FROM journal_entries WHERE business_id = $1 LIMIT 1`,
      [biz.id, acct.bankClearing],
    );
    await postCashEntry("2025-05-01", 999_000);

    const reconciliation = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    const detail = await reconciliationService.getReconciliation(biz.id, reconciliation.id);
    expect(detail.lines.map((l) => l.journalLineId)).toEqual([cashLineId]);
    expect(detail.lines[0].cleared).toBe(false);
    expect(detail.openingBalance).toBe(0);
  });
});

describe("setLineCleared and completeReconciliation", () => {
  it("requires the cleared total to exactly match the statement balance", async () => {
    const lineId = await postCashEntry("2025-04-10", 100_000);
    const reconciliation = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });

    await expect(
      reconciliationService.completeReconciliation({ businessId: biz.id, reconciliationId: reconciliation.id, actorId: user.id }),
    ).rejects.toThrow("balance_mismatch");

    await reconciliationService.setLineCleared({
      businessId: biz.id,
      reconciliationId: reconciliation.id,
      journalLineId: lineId,
      cleared: true,
    });
    const completed = await reconciliationService.completeReconciliation({
      businessId: biz.id,
      reconciliationId: reconciliation.id,
      actorId: user.id,
    });
    expect(completed.status).toBe("completed");
    expect(completed.difference).toBe(0);
  });

  it("un-clearing a line removes it from the cleared total", async () => {
    const lineId = await postCashEntry("2025-04-10", 100_000);
    const reconciliation = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 0,
      createdBy: user.id,
    });
    await reconciliationService.setLineCleared({
      businessId: biz.id,
      reconciliationId: reconciliation.id,
      journalLineId: lineId,
      cleared: true,
    });
    await reconciliationService.setLineCleared({
      businessId: biz.id,
      reconciliationId: reconciliation.id,
      journalLineId: lineId,
      cleared: false,
    });
    const detail = await reconciliationService.getReconciliation(biz.id, reconciliation.id);
    expect(detail.clearedTotal).toBe(0);
    expect(detail.lines[0].cleared).toBe(false);
  });

  it("rejects clearing a line once the reconciliation is completed", async () => {
    const lineId = await postCashEntry("2025-04-10", 100_000);
    const reconciliation = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    await reconciliationService.setLineCleared({
      businessId: biz.id,
      reconciliationId: reconciliation.id,
      journalLineId: lineId,
      cleared: true,
    });
    await reconciliationService.completeReconciliation({ businessId: biz.id, reconciliationId: reconciliation.id, actorId: user.id });

    await expect(
      reconciliationService.setLineCleared({
        businessId: biz.id,
        reconciliationId: reconciliation.id,
        journalLineId: lineId,
        cleared: false,
      }),
    ).rejects.toThrow("reconciliation_completed");
  });

  it("carries the completed statement balance forward as the next reconciliation's opening balance, excluding claimed lines", async () => {
    const line1 = await postCashEntry("2025-04-10", 100_000);
    const first = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    await reconciliationService.setLineCleared({ businessId: biz.id, reconciliationId: first.id, journalLineId: line1, cleared: true });
    await reconciliationService.completeReconciliation({ businessId: biz.id, reconciliationId: first.id, actorId: user.id });

    const line2 = await postCashEntry("2025-05-10", 40_000);
    const second = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-05-31",
      statementBalance: 140_000,
      createdBy: user.id,
    });
    const detail = await reconciliationService.getReconciliation(biz.id, second.id);
    expect(detail.openingBalance).toBe(100_000);
    expect(detail.lines.map((l) => l.journalLineId)).toEqual([line2]);

    await reconciliationService.setLineCleared({ businessId: biz.id, reconciliationId: second.id, journalLineId: line2, cleared: true });
    const completed = await reconciliationService.completeReconciliation({
      businessId: biz.id,
      reconciliationId: second.id,
      actorId: user.id,
    });
    expect(completed.difference).toBe(0);
  });
});
