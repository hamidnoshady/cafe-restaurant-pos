/**
 * Phase 16 exit criterion: "A full fiscal year can be closed: periods locked,
 * closing entries posted, statements produced, and the balance sheet
 * balances." This proves closeFiscalYear (closing-service.ts) end to end:
 * revenue/expense accounts roll into Retained Earnings, every period ends up
 * locked, and the year itself is marked closed — all in one transaction, and
 * only once every period is already reviewed (soft_closed).
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let fiscalService: typeof import("../src/lib/fiscal-periods-service");
let closingService: typeof import("../src/lib/closing-service");

const biz = { id: "" };
const acct = { cash: "", revenue: "", expense: "", retainedEarnings: "" };
const users = { owner: "", accountant: "", cashier: "" };

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
  databaseName = `pos_closing_${randomUUID().replaceAll("-", "")}`;

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
  fiscalService = await import("../src/lib/fiscal-periods-service");
  closingService = await import("../src/lib/closing-service");

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
  // journal_lines.account_id is ON DELETE RESTRICT (not CASCADE), so clear
  // the ledger explicitly before cascading the business away.
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Closing Co', $1) RETURNING id",
    [`closing-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  for (const role of ["owner", "accountant", "cashier"] as const) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, $2, 'Member', 'x') RETURNING id`,
      [biz.id, role],
    );
    users[role] = rows[0].id;
  }

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'), ($1, '4300', 'Sales', 'revenue'),
            ($1, '5900', 'Other expense', 'expense'), ($1, '3800', 'Retained earnings', 'equity')
     RETURNING id, code`,
    [biz.id],
  );
  for (const r of accounts.rows) {
    if (r.code === "1100") acct.cash = r.id;
    if (r.code === "4300") acct.revenue = r.id;
    if (r.code === "5900") acct.expense = r.id;
    if (r.code === "3800") acct.retainedEarnings = r.id;
  }
});

/** Posts a balanced two-line entry directly, mirroring what postJournalEntry does. */
async function postEntry(
  entryDate: string,
  debitAcct: string,
  creditAcct: string,
  amount: number,
  createdBy: string,
) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (business_id, entry_date, memo, source_type, created_by)
     VALUES ($1, $2, 'test', 'manual', $3) RETURNING id`,
    [biz.id, entryDate, createdBy],
  );
  const entryId = rows[0].id;
  await db.query(
    `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
    [entryId, debitAcct, amount, creditAcct],
  );
  return entryId;
}

async function accountBalance(accountId: string): Promise<number> {
  const { rows } = await db.query<{ debit: string; credit: string }>(
    `SELECT COALESCE(SUM(debit), 0) AS debit, COALESCE(SUM(credit), 0) AS credit
       FROM journal_lines WHERE account_id = $1`,
    [accountId],
  );
  return Number(rows[0].debit) - Number(rows[0].credit);
}

async function softCloseAllPeriods(fiscalYearId: string) {
  const periods = await fiscalService.listPeriods(biz.id, fiscalYearId);
  for (const p of periods) {
    await fiscalService.setPeriodStatus(
      biz.id,
      p.id,
      "soft_closed",
      users.owner,
    );
  }
  return periods;
}

describe("closeFiscalYear", () => {
  it("rolls net income into retained earnings and locks every period", async () => {
    await fiscalService.createFiscalYear(biz.id, 1404);
    const [year] = await fiscalService.listFiscalYears(biz.id);

    await postEntry(
      "2025-04-05",
      acct.cash,
      acct.revenue,
      1_000_000,
      users.owner,
    );
    await postEntry(
      "2025-05-05",
      acct.expense,
      acct.cash,
      400_000,
      users.owner,
    );

    await softCloseAllPeriods(year.id);

    const result = await closingService.closeFiscalYear(
      biz.id,
      year.id,
      users.owner,
    );
    expect(result.closingEntryId).not.toBeNull();
    expect(result.netIncome).toBe(600_000);

    expect(await accountBalance(acct.revenue)).toBe(0);
    expect(await accountBalance(acct.expense)).toBe(0);
    // accountBalance is debit-credit; retained earnings is equity, whose
    // normal balance is credit-debit, so a positive net income shows up here
    // as the negative of it (a credit balance).
    expect(await accountBalance(acct.retainedEarnings)).toBe(-600_000);

    const periods = await fiscalService.listPeriods(biz.id, year.id);
    expect(periods.every((p) => p.status === "locked")).toBe(true);

    const [closedYear] = await fiscalService.listFiscalYears(biz.id);
    expect(closedYear.closedAt).not.toBeNull();
  });

  it("debits retained earnings for a net loss", async () => {
    await fiscalService.createFiscalYear(biz.id, 1404);
    const [year] = await fiscalService.listFiscalYears(biz.id);

    await postEntry(
      "2025-04-05",
      acct.cash,
      acct.revenue,
      200_000,
      users.owner,
    );
    await postEntry(
      "2025-05-05",
      acct.expense,
      acct.cash,
      900_000,
      users.owner,
    );

    await softCloseAllPeriods(year.id);
    const result = await closingService.closeFiscalYear(
      biz.id,
      year.id,
      users.owner,
    );

    expect(result.netIncome).toBe(-700_000);
    // A loss debits retained earnings, so its debit-credit balance is positive.
    expect(await accountBalance(acct.retainedEarnings)).toBe(700_000);
  });

  it("posts no entry, but still locks every period, when there was no activity", async () => {
    await fiscalService.createFiscalYear(biz.id, 1404);
    const [year] = await fiscalService.listFiscalYears(biz.id);

    await softCloseAllPeriods(year.id);
    const result = await closingService.closeFiscalYear(
      biz.id,
      year.id,
      users.owner,
    );

    expect(result.closingEntryId).toBeNull();
    expect(result.netIncome).toBe(0);
    const periods = await fiscalService.listPeriods(biz.id, year.id);
    expect(periods.every((p) => p.status === "locked")).toBe(true);
  });

  it("rejects closing while any period is still open", async () => {
    await fiscalService.createFiscalYear(biz.id, 1404);
    const [year] = await fiscalService.listFiscalYears(biz.id);
    const periods = await fiscalService.listPeriods(biz.id, year.id);
    // Soft-close only the first period; the other eleven stay open.
    await fiscalService.setPeriodStatus(
      biz.id,
      periods[0].id,
      "soft_closed",
      users.owner,
    );

    await expect(
      closingService.closeFiscalYear(biz.id, year.id, users.owner),
    ).rejects.toThrow("periods_not_ready");
  });

  it("rejects closing an already-closed year", async () => {
    await fiscalService.createFiscalYear(biz.id, 1404);
    const [year] = await fiscalService.listFiscalYears(biz.id);
    await softCloseAllPeriods(year.id);
    await closingService.closeFiscalYear(biz.id, year.id, users.owner);

    await expect(
      closingService.closeFiscalYear(biz.id, year.id, users.owner),
    ).rejects.toThrow("fiscal_year_already_closed");
  });

  it("rejects closing a fiscal year that doesn't exist", async () => {
    await expect(
      closingService.closeFiscalYear(biz.id, randomUUID(), users.owner),
    ).rejects.toThrow("fiscal_year_not_found");
  });

  describe("postJournalEntry failure handling", () => {
    it("throws period_locked_for_closing if postJournalEntry throws a fiscal period lock error", async () => {
      await fiscalService.createFiscalYear(biz.id, 1404);
      const [year] = await fiscalService.listFiscalYears(biz.id);
      await softCloseAllPeriods(year.id);

      const ledgerService = await import("../src/lib/ledger-service");
      const spy = vi
        .spyOn(ledgerService, "postJournalEntry")
        .mockRejectedValue(new Error("fiscal_period_locked"));

      await expect(
        closingService.closeFiscalYear(biz.id, year.id, users.owner),
      ).rejects.toThrow("period_locked_for_closing");
      spy.mockRestore();
    });

    it("rethrows if postJournalEntry throws an unrelated error", async () => {
      await fiscalService.createFiscalYear(biz.id, 1404);
      const [year] = await fiscalService.listFiscalYears(biz.id);
      await softCloseAllPeriods(year.id);

      const ledgerService = await import("../src/lib/ledger-service");
      const spy = vi
        .spyOn(ledgerService, "postJournalEntry")
        .mockRejectedValue(new Error("some_other_error"));

      await expect(
        closingService.closeFiscalYear(biz.id, year.id, users.owner),
      ).rejects.toThrow("some_other_error");
      spy.mockRestore();
    });
  });
});

describe("reopening a period after its fiscal year is closed", () => {
  it("is rejected, to avoid an open period under an already-closed year", async () => {
    await fiscalService.createFiscalYear(biz.id, 1404);
    const [year] = await fiscalService.listFiscalYears(biz.id);
    await softCloseAllPeriods(year.id);
    await closingService.closeFiscalYear(biz.id, year.id, users.owner);

    const [farvardin] = await fiscalService.listPeriods(biz.id, year.id);
    await expect(
      fiscalService.setPeriodStatus(biz.id, farvardin.id, "open", users.owner),
    ).rejects.toThrow("fiscal_year_closed");
  });
});
