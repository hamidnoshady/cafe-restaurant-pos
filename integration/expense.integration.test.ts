/**
 * Phase 16 scope: "Expense management — categorised operating expenses with
 * attachments, recurring expenses, and their postings." Attachments and
 * recurring are deferred (see the phase doc); this proves the postings core:
 * a recorded expense posts a real, immediate, balanced journal entry
 * (Debit the chosen expense account / Credit the chosen payment account),
 * is subject to the fiscal-period lock like everything else, and rejects
 * an invalid account choice on either side.
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
let expenseService: typeof import("../src/lib/expense-service");
let fiscalService: typeof import("../src/lib/fiscal-periods-service");

const biz = { id: "" };
const acct = { cash: "", rent: "", revenue: "" };
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
  databaseName = `pos_expense_${randomUUID().replaceAll("-", "")}`;

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
  expenseService = await import("../src/lib/expense-service");
  fiscalService = await import("../src/lib/fiscal-periods-service");

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
  await db.query("DELETE FROM expenses");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Expense Co', $1) RETURNING id",
    [`expense-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const userRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
    [biz.id],
  );
  user.id = userRow.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'), ($1, '5300', 'Rent', 'expense'), ($1, '4300', 'Sales', 'revenue')
     RETURNING id, code`,
    [biz.id],
  );
  for (const r of accounts.rows) {
    if (r.code === "1100") acct.cash = r.id;
    if (r.code === "5300") acct.rent = r.id;
    if (r.code === "4300") acct.revenue = r.id;
  }
});

describe("recordExpense", () => {
  it("posts a balanced entry: debit the expense account, credit the payment account", async () => {
    const expense = await expenseService.recordExpense({
      businessId: biz.id,
      locationId: null,
      accountId: acct.rent,
      paymentAccountId: acct.cash,
      amount: 500_000,
      expenseDate: "2025-04-15",
      vendor: "Landlord Co",
      memo: "Monthly rent",
      createdBy: user.id,
    });
    expect(expense.amount).toBe(500_000);
    expect(expense.vendor).toBe("Landlord Co");

    const { rows: entries } = await db.query(
      `SELECT source_type, source_id, entry_date::text AS entry_date, memo FROM journal_entries WHERE business_id = $1`,
      [biz.id],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ source_type: "expense", source_id: expense.id, entry_date: "2025-04-15", memo: "Monthly rent" });

    const { rows: lines } = await db.query(
      `SELECT account_id, debit, credit FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id WHERE je.business_id = $1 ORDER BY debit DESC`,
      [biz.id],
    );
    expect(lines).toEqual([
      { account_id: acct.rent, debit: "500000", credit: "0" },
      { account_id: acct.cash, debit: "0", credit: "500000" },
    ]);
  });

  it("appears in listExpenses with account and payment-account names", async () => {
    await expenseService.recordExpense({
      businessId: biz.id,
      locationId: null,
      accountId: acct.rent,
      paymentAccountId: acct.cash,
      amount: 200_000,
      memo: "Utilities",
      createdBy: user.id,
    });
    const list = await expenseService.listExpenses(biz.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ accountCode: "5300", paymentAccountCode: "1100", amount: 200_000, memo: "Utilities" });
  });

  it("rejects a non-expense account as the category", async () => {
    await expect(
      expenseService.recordExpense({
        businessId: biz.id,
        locationId: null,
        accountId: acct.revenue,
        paymentAccountId: acct.cash,
        amount: 10_000,
        memo: "X",
        createdBy: user.id,
      }),
    ).rejects.toThrow("invalid_expense_account");
  });

  it("rejects a non-asset account as the payment source", async () => {
    await expect(
      expenseService.recordExpense({
        businessId: biz.id,
        locationId: null,
        accountId: acct.rent,
        paymentAccountId: acct.revenue,
        amount: 10_000,
        memo: "X",
        createdBy: user.id,
      }),
    ).rejects.toThrow("invalid_payment_account");
  });

  it("rejects the same account on both sides", async () => {
    await expect(
      expenseService.recordExpense({
        businessId: biz.id,
        locationId: null,
        accountId: acct.rent,
        paymentAccountId: acct.rent,
        amount: 10_000,
        memo: "X",
        createdBy: user.id,
      }),
    ).rejects.toThrow("same_account");
  });

  it("rejects a zero or negative amount, and an empty memo", async () => {
    await expect(
      expenseService.recordExpense({
        businessId: biz.id,
        locationId: null,
        accountId: acct.rent,
        paymentAccountId: acct.cash,
        amount: 0,
        memo: "X",
        createdBy: user.id,
      }),
    ).rejects.toThrow("invalid_amount");
    await expect(
      expenseService.recordExpense({
        businessId: biz.id,
        locationId: null,
        accountId: acct.rent,
        paymentAccountId: acct.cash,
        amount: 10_000,
        memo: "  ",
        createdBy: user.id,
      }),
    ).rejects.toThrow("memo_required");
  });

  it("rejects an account from a different business", async () => {
    const other = await db.query<{ id: string }>("INSERT INTO businesses (name, slug) VALUES ('Other Co', $1) RETURNING id", [
      `other-${randomUUID().slice(0, 8)}`,
    ]);
    const otherAccount = await db.query<{ id: string }>(
      `INSERT INTO accounts (business_id, code, name, type) VALUES ($1, '5300', 'Rent', 'expense') RETURNING id`,
      [other.rows[0].id],
    );
    await expect(
      expenseService.recordExpense({
        businessId: biz.id,
        locationId: null,
        accountId: otherAccount.rows[0].id,
        paymentAccountId: acct.cash,
        amount: 10_000,
        memo: "X",
        createdBy: user.id,
      }),
    ).rejects.toThrow("unknown_account");
  });

  it("rejects posting into a locked fiscal period", async () => {
    await fiscalService.createFiscalYear(biz.id, 1404);
    const [year] = await fiscalService.listFiscalYears(biz.id);
    const [farvardin] = await fiscalService.listPeriods(biz.id, year.id);
    await fiscalService.setPeriodStatus(biz.id, farvardin.id, "soft_closed", user.id);
    await fiscalService.setPeriodStatus(biz.id, farvardin.id, "locked", user.id);

    await expect(
      expenseService.recordExpense({
        businessId: biz.id,
        locationId: null,
        accountId: acct.rent,
        paymentAccountId: acct.cash,
        amount: 10_000,
        expenseDate: farvardin.startsOn,
        memo: "X",
        createdBy: user.id,
      }),
    ).rejects.toThrow("fiscal_period_locked");
  });
});
