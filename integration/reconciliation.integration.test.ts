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
 * The bugs this screen shipped with, each pinned by the case that exposed it.
 * Every one of these was reproducible against a running instance before the
 * fix: three returned a 500 and «خطای غیرمنتظره», three quietly corrupted the
 * reconciliation chain.
 */
describe("input that used to crash instead of answering", () => {
  it("answers a malformed statement date rather than letting the date column raise", async () => {
    // Was: `invalid input syntax for type date` → 500.
    await expect(
      reconciliationService.createReconciliation({
        businessId: biz.id,
        accountCode: "cash",
        statementDate: "not-a-date",
        statementBalance: 100_000,
        createdBy: user.id,
      }),
    ).rejects.toThrow("invalid_statement_date");
  });

  it("refuses a Jalali year that reached the Gregorian wire field", async () => {
    // Was: accepted as Gregorian year 1404 — a statement six centuries back
    // that no posting could ever match, and an un-completable reconciliation
    // blocking the account.
    await expect(
      reconciliationService.createReconciliation({
        businessId: biz.id,
        accountCode: "cash",
        statementDate: "1404-04-09",
        statementBalance: 100_000,
        createdBy: user.id,
      }),
    ).rejects.toThrow("invalid_statement_date");
  });

  it("answers a non-uuid reconciliation id with not-found, not a 500", async () => {
    await expect(reconciliationService.getReconciliation(biz.id, "not-a-uuid")).rejects.toThrow(
      "reconciliation_not_found",
    );
    await expect(
      reconciliationService.setLineCleared({
        businessId: biz.id,
        reconciliationId: "not-a-uuid",
        journalLineId: "1",
        cleared: true,
      }),
    ).rejects.toThrow("reconciliation_not_found");
  });

  it("answers a non-numeric journal line id with not-found, not a 500", async () => {
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
        journalLineId: "abc",
        cleared: true,
      }),
    ).rejects.toThrow("journal_line_not_found");
  });
});

describe("the reconciliation chain cannot be corrupted", () => {
  it("refuses to clear a line posted after the statement date", async () => {
    // Was: accepted. The line was locked to a reconciliation that then never
    // displayed it (candidateLines stops at the statement date), and no later
    // reconciliation could claim it either — money silently left the
    // reconcilable set.
    const lateLine = await postCashEntry("2025-05-10", 40_000);
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
        journalLineId: lateLine,
        cleared: true,
      }),
    ).rejects.toThrow("journal_line_not_found");

    const detail = await reconciliationService.getReconciliation(biz.id, reconciliation.id);
    expect(detail.clearedTotal).toBe(0);
  });

  it("says so when a line is already locked by another reconciliation, instead of reporting success", async () => {
    // Was: `ON CONFLICT DO NOTHING` swallowed it — the caller got «ok», the
    // tick appeared to take, and it vanished on the next read.
    const line = await postCashEntry("2025-04-10", 100_000);
    const first = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    await reconciliationService.setLineCleared({
      businessId: biz.id,
      reconciliationId: first.id,
      journalLineId: line,
      cleared: true,
    });
    await reconciliationService.completeReconciliation({
      businessId: biz.id,
      reconciliationId: first.id,
      actorId: user.id,
    });

    const second = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-05-31",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    await expect(
      reconciliationService.setLineCleared({
        businessId: biz.id,
        reconciliationId: second.id,
        journalLineId: line,
        cleared: true,
      }),
    ).rejects.toThrow("journal_line_already_reconciled");
  });

  it("re-clearing a line this reconciliation already holds stays a no-op", async () => {
    const line = await postCashEntry("2025-04-10", 100_000);
    const reconciliation = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    const clear = () =>
      reconciliationService.setLineCleared({
        businessId: biz.id,
        reconciliationId: reconciliation.id,
        journalLineId: line,
        cleared: true,
      });
    await clear();
    // A double-click or an offline retry must not become an error.
    await expect(clear()).resolves.toBeUndefined();
    const detail = await reconciliationService.getReconciliation(biz.id, reconciliation.id);
    expect(detail.clearedTotal).toBe(100_000);
  });

  it("refuses a statement dated into an already-locked period", async () => {
    // Was: accepted, and opened from the *later* reconciliation's closing
    // balance — a period opening from its own future, permanently unclosable,
    // and blocking every new reconciliation on the account.
    const line = await postCashEntry("2025-05-10", 100_000);
    const july = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-05-31",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    await reconciliationService.setLineCleared({
      businessId: biz.id,
      reconciliationId: july.id,
      journalLineId: line,
      cleared: true,
    });
    await reconciliationService.completeReconciliation({
      businessId: biz.id,
      reconciliationId: july.id,
      actorId: user.id,
    });

    await expect(
      reconciliationService.createReconciliation({
        businessId: biz.id,
        accountCode: "cash",
        statementDate: "2025-04-30",
        statementBalance: 999,
        createdBy: user.id,
      }),
    ).rejects.toThrow("statement_date_already_reconciled");
  });

  it("only one of two concurrent completions wins, so the audit trail is not overwritten", async () => {
    // Was: both passed the read-then-write guard and both UPDATEd, so
    // completed_at/completed_by named whoever finished second.
    const line = await postCashEntry("2025-04-10", 100_000);
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
      journalLineId: line,
      cleared: true,
    });

    const results = await Promise.allSettled([
      reconciliationService.completeReconciliation({
        businessId: biz.id,
        reconciliationId: reconciliation.id,
        actorId: user.id,
      }),
      reconciliationService.completeReconciliation({
        businessId: biz.id,
        reconciliationId: reconciliation.id,
        actorId: user.id,
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
});

describe("opening balance follows the statement date, not merely the newest lock", () => {
  it("opens a backdated-but-allowed account from 0 when every completed reconciliation is later", async () => {
    // `openingBalance` is bounded by `statement_date <= $4`. Proven on a second
    // account, where a later completed reconciliation exists but belongs to a
    // different account and must not leak into this one's opening balance.
    const cashLine = await postCashEntry("2025-04-10", 100_000);
    const cash = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    await reconciliationService.setLineCleared({
      businessId: biz.id,
      reconciliationId: cash.id,
      journalLineId: cashLine,
      cleared: true,
    });
    await reconciliationService.completeReconciliation({
      businessId: biz.id,
      reconciliationId: cash.id,
      actorId: user.id,
    });

    const clearing = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "bankClearing",
      statementDate: "2025-03-31",
      statementBalance: 0,
      createdBy: user.id,
    });
    const detail = await reconciliationService.getReconciliation(biz.id, clearing.id);
    expect(detail.openingBalance).toBe(0);
  });
});

describe("discarding an in-progress reconciliation", () => {
  it("releases its claimed lines and frees the account, so a typo is recoverable", async () => {
    // Was: impossible. One reconciliation per account, no way to edit the
    // statement balance, and a difference that can never reach zero cannot be
    // completed — a mistyped closing balance wedged the account permanently.
    const line = await postCashEntry("2025-04-10", 100_000);
    const typo = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 999_999_999,
      createdBy: user.id,
    });
    await reconciliationService.setLineCleared({
      businessId: biz.id,
      reconciliationId: typo.id,
      journalLineId: line,
      cleared: true,
    });

    await reconciliationService.discardReconciliation({
      businessId: biz.id,
      reconciliationId: typo.id,
    });
    await expect(reconciliationService.getReconciliation(biz.id, typo.id)).rejects.toThrow(
      "reconciliation_not_found",
    );

    // The account is free again and the line is back in the candidate pool.
    const retry = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    const detail = await reconciliationService.getReconciliation(biz.id, retry.id);
    expect(detail.lines.map((l) => l.journalLineId)).toEqual([line]);
    expect(detail.lines[0].cleared).toBe(false);
  });

  it("refuses to discard a completed reconciliation, which is the next period's opening balance", async () => {
    const line = await postCashEntry("2025-04-10", 100_000);
    const done = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    await reconciliationService.setLineCleared({
      businessId: biz.id,
      reconciliationId: done.id,
      journalLineId: line,
      cleared: true,
    });
    await reconciliationService.completeReconciliation({
      businessId: biz.id,
      reconciliationId: done.id,
      actorId: user.id,
    });

    await expect(
      reconciliationService.discardReconciliation({ businessId: biz.id, reconciliationId: done.id }),
    ).rejects.toThrow("reconciliation_completed");
  });

  it("answers a non-uuid id with not-found rather than raising", async () => {
    await expect(
      reconciliationService.discardReconciliation({
        businessId: biz.id,
        reconciliationId: "not-a-uuid",
      }),
    ).rejects.toThrow("reconciliation_not_found");
  });
});

describe("a negative closing balance is judged per account", () => {
  it("refuses a negative balance for the till, which cannot hold less than nothing", async () => {
    // A minus here is a typo or a sign flip (the period's movement entered
    // instead of its closing balance). It used to be accepted, and then never
    // reconciled.
    await expect(
      reconciliationService.createReconciliation({
        businessId: biz.id,
        accountCode: "cash",
        statementDate: "2025-04-30",
        statementBalance: -100_000,
        createdBy: user.id,
      }),
    ).rejects.toThrow("negative_statement_balance");
  });

  it("refuses a negative balance for the card-reader float, for the same reason", async () => {
    await expect(
      reconciliationService.createReconciliation({
        businessId: biz.id,
        accountCode: "bankClearing",
        statementDate: "2025-04-30",
        statementBalance: -1,
        createdBy: user.id,
      }),
    ).rejects.toThrow("negative_statement_balance");
  });

  it("allows a negative balance for the bank account, which can genuinely be overdrawn", async () => {
    const overdrawn = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "bank",
      statementDate: "2025-04-30",
      statementBalance: -250_000,
      createdBy: user.id,
    });
    expect(overdrawn.statementBalance).toBe(-250_000);
  });
});
