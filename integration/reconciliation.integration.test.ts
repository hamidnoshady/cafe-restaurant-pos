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
const acct = { cash: "", bank: "", bankClearing: "", revenue: "" };
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
     VALUES ($1, '1100', 'Cash', 'asset'), ($1, '1110', 'Bank', 'asset'),
            ($1, '1120', 'Card clearing', 'asset'), ($1, '4300', 'Sales', 'revenue')
     RETURNING id, code`,
    [biz.id],
  );
  for (const r of accounts.rows) {
    if (r.code === "1100") acct.cash = r.id;
    if (r.code === "1110") acct.bank = r.id;
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

/**
 * The bugs found reviewing «تطبیق بانکی و صندوق» end to end. Each of these was
 * reachable from the screen as it shipped; each one is now refused, repaired or
 * escapable, and the test says which.
 */
describe("bank (1110) — the account the screen is named after", () => {
  it("reconciles postings on 1110, the account a cheque clears into", async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, entry_date, memo, source_type)
       VALUES ($1, '2025-04-10', 'Cheque cleared', 'cheque') RETURNING id`,
      [biz.id],
    );
    const { rows: lineRows } = await db.query<{ id: string }>(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, 500000, 0) RETURNING id`,
      [rows[0].id, acct.bank],
    );
    await db.query(`INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, 0, 500000)`, [
      rows[0].id,
      acct.revenue,
    ]);

    const reconciliation = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "bank",
      statementDate: "2025-04-30",
      statementBalance: 500_000,
      createdBy: user.id,
    });
    // The regression a two-way "cash, else bankClearing" ternary used to cause:
    // every بانک reconciliation reported itself as a کارت‌خوان one.
    expect(reconciliation.accountCode).toBe("bank");
    expect(reconciliation.accountLabel).toBe("بانک");

    const detail = await reconciliationService.getReconciliation(biz.id, reconciliation.id);
    expect(detail.lines.map((l) => l.journalLineId)).toEqual([lineRows[0].id]);
    expect(detail.accountCode).toBe("bank");
  });
});

describe("statement date", () => {
  it("refuses a date that is not a date rather than letting Postgres raise a 500", async () => {
    await expect(
      reconciliationService.createReconciliation({
        businessId: biz.id,
        accountCode: "cash",
        statementDate: "2025-13-45",
        statementBalance: 0,
        createdBy: user.id,
      }),
    ).rejects.toThrow("invalid_statement_date");
  });

  it("refuses one dated before the last completed reconciliation", async () => {
    const lineId = await postCashEntry("2025-04-10", 100_000);
    const first = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    await reconciliationService.setLineCleared({ businessId: biz.id, reconciliationId: first.id, journalLineId: lineId, cleared: true });
    await reconciliationService.completeReconciliation({ businessId: biz.id, reconciliationId: first.id, actorId: user.id });

    // Its opening balance would be April's closing balance — a figure from its
    // own future, and a «مغایرت» that means nothing.
    await expect(
      reconciliationService.createReconciliation({
        businessId: biz.id,
        accountCode: "cash",
        statementDate: "2025-03-31",
        statementBalance: 0,
        createdBy: user.id,
      }),
    ).rejects.toThrow("statement_date_before_last");
  });
});

describe("opening balance", () => {
  it("is the balance of the reconciliation before it, never one from its own future", async () => {
    const aprilLine = await postCashEntry("2025-04-10", 100_000);
    const april = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    await reconciliationService.setLineCleared({ businessId: biz.id, reconciliationId: april.id, journalLineId: aprilLine, cleared: true });
    await reconciliationService.completeReconciliation({ businessId: biz.id, reconciliationId: april.id, actorId: user.id });

    const mayLine = await postCashEntry("2025-05-10", 40_000);
    const may = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-05-31",
      statementBalance: 140_000,
      createdBy: user.id,
    });
    await reconciliationService.setLineCleared({ businessId: biz.id, reconciliationId: may.id, journalLineId: mayLine, cleared: true });
    await reconciliationService.completeReconciliation({ businessId: biz.id, reconciliationId: may.id, actorId: user.id });

    // Re-reading April now that May is locked: April still opens at zero.
    // "The most recent completed one that isn't this one" used to answer with
    // May's 140,000 and show April a 140,000 discrepancy that never existed.
    const aprilAgain = await reconciliationService.getReconciliation(biz.id, april.id);
    expect(aprilAgain.openingBalance).toBe(0);
    expect(aprilAgain.difference).toBe(0);

    const mayAgain = await reconciliationService.getReconciliation(biz.id, may.id);
    expect(mayAgain.openingBalance).toBe(100_000);
    expect(mayAgain.difference).toBe(0);
  });
});

describe("clearing lines", () => {
  it("refuses a line dated after the statement date — one the screen never showed", async () => {
    await postCashEntry("2025-04-10", 100_000);
    const futureLine = await postCashEntry("2025-05-20", 999_000);
    const reconciliation = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });

    // Claiming it would hide it from every future reconciliation too, with
    // nothing anywhere to show why.
    await expect(
      reconciliationService.setLineCleared({
        businessId: biz.id,
        reconciliationId: reconciliation.id,
        journalLineId: futureLine,
        cleared: true,
      }),
    ).rejects.toThrow("journal_line_not_found");
  });

  it("refuses a line belonging to another account", async () => {
    const cashLine = await postCashEntry("2025-04-10", 100_000);
    const reconciliation = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "bankClearing",
      statementDate: "2025-04-30",
      statementBalance: 0,
      createdBy: user.id,
    });
    await expect(
      reconciliationService.setLineCleared({
        businessId: biz.id,
        reconciliationId: reconciliation.id,
        journalLineId: cashLine,
        cleared: true,
      }),
    ).rejects.toThrow("journal_line_not_found");
  });

  it("answers a non-numeric line id with a 404 rather than a bigint syntax error", async () => {
    const reconciliation = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 0,
      createdBy: user.id,
    });
    await expect(
      reconciliationService.setLineCleared({
        businessId: biz.id,
        reconciliationId: reconciliation.id,
        journalLineId: "not-a-line",
        cleared: true,
      }),
    ).rejects.toThrow("journal_line_not_found");
  });

  it("answers a non-uuid reconciliation id with a 404 rather than a uuid syntax error", async () => {
    await expect(reconciliationService.getReconciliation(biz.id, "nope")).rejects.toThrow(
      "reconciliation_not_found",
    );
  });

  it("clears a whole set of lines in one statement", async () => {
    const ids = [
      await postCashEntry("2025-04-01", 10_000),
      await postCashEntry("2025-04-02", 20_000),
      await postCashEntry("2025-04-03", 30_000),
    ];
    const reconciliation = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 60_000,
      createdBy: user.id,
    });
    const { changed } = await reconciliationService.setLinesCleared({
      businessId: biz.id,
      reconciliationId: reconciliation.id,
      journalLineIds: ids,
      cleared: true,
    });
    expect(changed).toBe(3);

    const detail = await reconciliationService.getReconciliation(biz.id, reconciliation.id);
    expect(detail.clearedCount).toBe(3);
    expect(detail.clearedTotal).toBe(60_000);
    expect(detail.difference).toBe(0);

    // And back out again, in one statement.
    await reconciliationService.setLinesCleared({
      businessId: biz.id,
      reconciliationId: reconciliation.id,
      journalLineIds: ids,
      cleared: false,
    });
    const after = await reconciliationService.getReconciliation(biz.id, reconciliation.id);
    expect(after.clearedTotal).toBe(0);
  });

  it("rejects the whole batch when one member is invalid, rather than half-applying it", async () => {
    const good = await postCashEntry("2025-04-01", 10_000);
    const future = await postCashEntry("2025-05-20", 20_000);
    const reconciliation = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 10_000,
      createdBy: user.id,
    });
    await expect(
      reconciliationService.setLinesCleared({
        businessId: biz.id,
        reconciliationId: reconciliation.id,
        journalLineIds: [good, future],
        cleared: true,
      }),
    ).rejects.toThrow("journal_line_not_found");

    const detail = await reconciliationService.getReconciliation(biz.id, reconciliation.id);
    expect(detail.clearedCount).toBe(0);
  });

  it("refuses an empty selection", async () => {
    const reconciliation = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 0,
      createdBy: user.id,
    });
    await expect(
      reconciliationService.setLinesCleared({
        businessId: biz.id,
        reconciliationId: reconciliation.id,
        journalLineIds: [],
        cleared: true,
      }),
    ).rejects.toThrow("journal_line_required");
  });
});

describe("cancelling an in-progress reconciliation", () => {
  it("frees the account and releases every line it had claimed", async () => {
    const lineId = await postCashEntry("2025-04-10", 100_000);
    // Started with the wrong balance: it can never be made to balance, so
    // before this existed the account's screen was stuck for good.
    const wrong = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 999_999,
      createdBy: user.id,
    });
    await reconciliationService.setLineCleared({ businessId: biz.id, reconciliationId: wrong.id, journalLineId: lineId, cleared: true });

    await reconciliationService.deleteReconciliation({ businessId: biz.id, reconciliationId: wrong.id });

    expect(await reconciliationService.listReconciliations(biz.id, "cash")).toEqual([]);
    const { rows } = await db.query("SELECT 1 FROM bank_reconciliation_lines WHERE journal_line_id = $1", [lineId]);
    expect(rows).toHaveLength(0);

    // The account is free again, and the released line is a candidate once more.
    const retry = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    const detail = await reconciliationService.getReconciliation(biz.id, retry.id);
    expect(detail.lines.map((l) => l.journalLineId)).toEqual([lineId]);
  });

  it("refuses to delete a completed reconciliation — the lock the whole feature rests on", async () => {
    const lineId = await postCashEntry("2025-04-10", 100_000);
    const reconciliation = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    await reconciliationService.setLineCleared({ businessId: biz.id, reconciliationId: reconciliation.id, journalLineId: lineId, cleared: true });
    await reconciliationService.completeReconciliation({ businessId: biz.id, reconciliationId: reconciliation.id, actorId: user.id });

    await expect(
      reconciliationService.deleteReconciliation({ businessId: biz.id, reconciliationId: reconciliation.id }),
    ).rejects.toThrow("reconciliation_completed");
  });
});

describe("completing", () => {
  it("locks exactly once when two requests race", async () => {
    const lineId = await postCashEntry("2025-04-10", 100_000);
    const reconciliation = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    await reconciliationService.setLineCleared({ businessId: biz.id, reconciliationId: reconciliation.id, journalLineId: lineId, cleared: true });

    const results = await Promise.allSettled([
      reconciliationService.completeReconciliation({ businessId: biz.id, reconciliationId: reconciliation.id, actorId: user.id }),
      reconciliationService.completeReconciliation({ businessId: biz.id, reconciliationId: reconciliation.id, actorId: user.id }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason.message).toBe("reconciliation_completed");
  });
});

describe("the account overview the start form is filled in from", () => {
  it("reports the ledger balance, the last statement and what is still unmatched", async () => {
    const lineId = await postCashEntry("2025-04-10", 100_000);
    await postCashEntry("2025-05-10", 40_000);

    const before = await reconciliationService.getAccountOverview(biz.id, "cash");
    expect(before.accountCode).toBe("cash");
    expect(before.accountLabel).toBe("صندوق");
    expect(before.accountLedgerCode).toBe("1100");
    expect(before.openingBalance).toBe(0);
    expect(before.lastStatementDate).toBeNull();
    expect(before.ledgerBalance).toBe(140_000);
    expect(before.unreconciledCount).toBe(2);
    expect(before.unreconciledTotal).toBe(140_000);

    const first = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    await reconciliationService.setLineCleared({ businessId: biz.id, reconciliationId: first.id, journalLineId: lineId, cleared: true });
    await reconciliationService.completeReconciliation({ businessId: biz.id, reconciliationId: first.id, actorId: user.id });

    const after = await reconciliationService.getAccountOverview(biz.id, "cash");
    expect(after.openingBalance).toBe(100_000);
    expect(after.lastStatementDate).toBe("2025-04-30");
    expect(after.ledgerBalance).toBe(140_000);
    expect(after.unreconciledCount).toBe(1);
    expect(after.unreconciledTotal).toBe(40_000);
  });

  it("says ledger_account_missing when the chart of accounts has no such account", async () => {
    await db.query("DELETE FROM accounts WHERE id = $1", [acct.bank]);
    await expect(reconciliationService.getAccountOverview(biz.id, "bank")).rejects.toThrow(
      "ledger_account_missing",
    );
  });
});

describe("the history a reader sees", () => {
  it("carries each row's account label and how many items it claims", async () => {
    const lineId = await postCashEntry("2025-04-10", 100_000);
    const reconciliation = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    await reconciliationService.setLineCleared({ businessId: biz.id, reconciliationId: reconciliation.id, journalLineId: lineId, cleared: true });
    await reconciliationService.completeReconciliation({ businessId: biz.id, reconciliationId: reconciliation.id, actorId: user.id });

    const [row] = await reconciliationService.listReconciliations(biz.id, "cash");
    expect(row.accountLabel).toBe("صندوق");
    expect(row.clearedCount).toBe(1);
    expect(row.status).toBe("completed");
    expect(row.completedAt).not.toBeNull();
  });
});
