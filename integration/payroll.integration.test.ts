/**
 * Phase 16 scope: "Payroll entries — staff cost accrual and payment
 * postings (journal-level, not a payroll engine)." Proves: accrual posts a
 * balanced entry against every active staff member's current monthly_wage,
 * snapshotting each person's amount so it survives a later wage change;
 * paying an accrued run posts the other half and can't happen twice; and a
 * run with no wages set is refused rather than posting a zero entry.
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
let payrollService: typeof import("../src/lib/payroll-service");
let fiscalService: typeof import("../src/lib/fiscal-periods-service");
let provisioning: typeof import("../src/lib/business-provisioning");

const biz = { id: "" };
const acct = { cash: "", salariesExpense: "", salariesPayable: "" };
const staff = { a: "", b: "" };
const owner = { id: "" };

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
  databaseName = `pos_payroll_${randomUUID().replaceAll("-", "")}`;

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
  payrollService = await import("../src/lib/payroll-service");
  fiscalService = await import("../src/lib/fiscal-periods-service");
  provisioning = await import("../src/lib/business-provisioning");

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
  await db.query("DELETE FROM payroll_run_lines");
  await db.query("DELETE FROM payroll_runs");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Payroll Co', $1) RETURNING id",
    [`payroll-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const ownerRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
    [biz.id],
  );
  owner.id = ownerRow.rows[0].id;

  const staffRows = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash, monthly_wage)
     VALUES ($1, 'cashier', 'Staff A', 'x', 30000000), ($1, 'waiter', 'Staff B', 'x', 20000000)
     RETURNING id`,
    [biz.id],
  );
  staff.a = staffRows.rows[0].id;
  staff.b = staffRows.rows[1].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'), ($1, '5200', 'Salaries expense', 'expense'), ($1, '2300', 'Salaries payable', 'liability')
     RETURNING id, code`,
    [biz.id],
  );
  for (const r of accounts.rows) {
    if (r.code === "1100") acct.cash = r.id;
    if (r.code === "5200") acct.salariesExpense = r.id;
    if (r.code === "2300") acct.salariesPayable = r.id;
  }
});

describe("setWage / listStaffWages", () => {
  it("sets and lists a staff member's monthly wage", async () => {
    await payrollService.setWage(biz.id, staff.a, 35_000_000);
    const list = await payrollService.listStaffWages(biz.id);
    expect(list.find((s) => s.id === staff.a)!.monthlyWage).toBe(35_000_000);
  });

  it("rejects a negative wage", async () => {
    await expect(payrollService.setWage(biz.id, staff.a, -1)).rejects.toThrow("invalid_amount");
  });

  it("404s setting a wage for a user that doesn't exist", async () => {
    await expect(payrollService.setWage(biz.id, randomUUID(), 10_000_000)).rejects.toThrow("user_not_found");
  });
});

describe("accruePayroll", () => {
  it("posts a balanced entry summing every active staff member's current wage", async () => {
    const run = await payrollService.accruePayroll({
      businessId: biz.id,
      locationId: null,
      periodLabel: "مرداد ۱۴۰۴",
      accrualDate: "2025-05-20",
      createdBy: owner.id,
    });
    expect(run.totalAmount).toBe(50_000_000);
    expect(run.status).toBe("accrued");
    expect(run.lines.map((l) => l.amount).sort((a, b) => a - b)).toEqual([20_000_000, 30_000_000]);

    const { rows: entries } = await db.query(
      `SELECT source_type, source_id, entry_date::text AS entry_date FROM journal_entries WHERE business_id = $1`,
      [biz.id],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ source_type: "payroll_accrual", source_id: run.id, entry_date: "2025-05-20" });

    const { rows: lines } = await db.query(
      `SELECT account_id, debit, credit FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id WHERE je.business_id = $1 ORDER BY debit DESC`,
      [biz.id],
    );
    expect(lines).toEqual([
      { account_id: acct.salariesExpense, debit: "50000000", credit: "0" },
      { account_id: acct.salariesPayable, debit: "0", credit: "50000000" },
    ]);
  });

  it("snapshots each person's amount so a later wage change doesn't affect a past run", async () => {
    const run = await payrollService.accruePayroll({
      businessId: biz.id,
      locationId: null,
      periodLabel: "مرداد",
      createdBy: owner.id,
    });
    await payrollService.setWage(biz.id, staff.a, 99_000_000);

    const runs = await payrollService.listPayrollRuns(biz.id);
    const reloaded = runs.find((r) => r.id === run.id)!;
    expect(reloaded.totalAmount).toBe(50_000_000);
    expect(reloaded.lines.find((l) => l.userId === staff.a)!.amount).toBe(30_000_000);
  });

  it("excludes staff with no wage set or a zero wage", async () => {
    await db.query(`UPDATE users SET monthly_wage = 0 WHERE id = $1`, [staff.b]);
    const run = await payrollService.accruePayroll({
      businessId: biz.id,
      locationId: null,
      periodLabel: "مرداد",
      createdBy: owner.id,
    });
    expect(run.totalAmount).toBe(30_000_000);
    expect(run.lines).toHaveLength(1);
  });

  it("refuses to accrue when no staff has a wage set", async () => {
    await db.query(`UPDATE users SET monthly_wage = NULL WHERE business_id = $1`, [biz.id]);
    await expect(
      payrollService.accruePayroll({ businessId: biz.id, locationId: null, periodLabel: "مرداد", createdBy: owner.id }),
    ).rejects.toThrow("no_wages_set");
  });

  it("rejects an empty period label", async () => {
    await expect(
      payrollService.accruePayroll({ businessId: biz.id, locationId: null, periodLabel: "  ", createdBy: owner.id }),
    ).rejects.toThrow("period_label_required");
  });

  it("rejects accruing into a locked fiscal period", async () => {
    await fiscalService.createFiscalYear(biz.id, 1404);
    const [year] = await fiscalService.listFiscalYears(biz.id);
    const [farvardin] = await fiscalService.listPeriods(biz.id, year.id);
    await fiscalService.setPeriodStatus(biz.id, farvardin.id, "soft_closed", owner.id);
    await fiscalService.setPeriodStatus(biz.id, farvardin.id, "locked", owner.id);

    await expect(
      payrollService.accruePayroll({
        businessId: biz.id,
        locationId: null,
        periodLabel: "فروردین",
        accrualDate: farvardin.startsOn,
        createdBy: owner.id,
      }),
    ).rejects.toThrow("fiscal_period_locked");
  });
});

describe("payPayroll", () => {
  it("posts the payment half and marks the run paid", async () => {
    const run = await payrollService.accruePayroll({
      businessId: biz.id,
      locationId: null,
      periodLabel: "مرداد",
      createdBy: owner.id,
    });

    const paid = await payrollService.payPayroll({
      businessId: biz.id,
      locationId: null,
      runId: run.id,
      method: "cash",
      actorId: owner.id,
    });
    expect(paid.status).toBe("paid");
    expect(paid.paidDate).not.toBeNull();

    const { rows: entries } = await db.query(
      `SELECT source_type, source_id FROM journal_entries WHERE business_id = $1 AND source_type = 'payroll_payment'`,
      [biz.id],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].source_id).toBe(run.id);

    const { rows: lines } = await db.query(
      `SELECT account_id, debit, credit FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
        WHERE je.source_type = 'payroll_payment' AND je.business_id = $1 ORDER BY debit DESC`,
      [biz.id],
    );
    expect(lines).toEqual([
      { account_id: acct.salariesPayable, debit: "50000000", credit: "0" },
      { account_id: acct.cash, debit: "0", credit: "50000000" },
    ]);
  });

  it("404s paying a run that doesn't exist", async () => {
    await expect(
      payrollService.payPayroll({ businessId: biz.id, locationId: null, runId: randomUUID(), method: "cash", actorId: owner.id }),
    ).rejects.toThrow("run_not_found");
  });

  it("refuses to pay an already-paid run", async () => {
    const run = await payrollService.accruePayroll({
      businessId: biz.id,
      locationId: null,
      periodLabel: "مرداد",
      createdBy: owner.id,
    });
    await payrollService.payPayroll({ businessId: biz.id, locationId: null, runId: run.id, method: "cash", actorId: owner.id });

    await expect(
      payrollService.payPayroll({ businessId: biz.id, locationId: null, runId: run.id, method: "cash", actorId: owner.id }),
    ).rejects.toThrow("already_paid");
  });
});

/**
 * Payroll is not an F&B feature: `industry-profile.ts` puts `ledger` in
 * CORE_MODULES, so /dashboard/ledger → «حقوق و دستمزد» is offered to a jeweller
 * and a cosmetics shop exactly as it is to a café. Their seeded charts, though,
 * were written as "the generic accounts plus this trade's inventory/revenue/COGS
 * triple" and never picked up 5200 — so every one of those businesses got
 * `ledger_account_missing: 5200` the first time it ran payroll.
 *
 * This seeds from the real template rather than hand-inserting the accounts,
 * which is the whole point: hand-inserting is what let the gap hide.
 */
describe("payroll for a business that is not a café", () => {
  it.each(["jewelry", "watch", "accessories", "cosmetics"] as const)(
    "accrues against the %s template's own chart",
    async (industry) => {
      const bizRow = await db.query<{ id: string }>(
        "INSERT INTO businesses (name, slug, industry) VALUES ($1, $2, $3) RETURNING id",
        [`${industry} Co`, `${industry}-${randomUUID().slice(0, 8)}`, industry],
      );
      const businessId = bizRow.rows[0].id;

      await db.query(
        `INSERT INTO users (business_id, role, full_name, pin_hash, monthly_wage)
         VALUES ($1, 'cashier', 'Staff', 'x', 25000000)`,
        [businessId],
      );

      const client = await dbLib.getPool().connect();
      try {
        await provisioning.seedChartOfAccounts(client, businessId, industry);
      } finally {
        client.release();
      }

      const run = await payrollService.accruePayroll({
        businessId,
        locationId: null,
        periodLabel: "مرداد ۱۴۰۴",
        createdBy: null,
      });
      expect(run.totalAmount).toBe(25_000_000);

      // And it landed in the right two accounts, not merely "somewhere".
      const { rows } = await db.query<{ code: string; debit: string; credit: string }>(
        `SELECT a.code, jl.debit::text AS debit, jl.credit::text AS credit
           FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.entry_id
           JOIN accounts a ON a.id = jl.account_id
          WHERE je.business_id = $1 AND je.source_type = 'payroll_accrual'
          ORDER BY a.code`,
        [businessId],
      );
      expect(rows.map((r) => r.code)).toEqual(["2300", "5200"]);
      expect(Number(rows.find((r) => r.code === "5200")!.debit)).toBe(25_000_000);
      expect(Number(rows.find((r) => r.code === "2300")!.credit)).toBe(25_000_000);
    },
  );
});
