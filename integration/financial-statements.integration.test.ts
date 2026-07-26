/**
 * Phase 16 exit criteria: P&L/Balance Sheet/Cash Flow each get period
 * comparison and drill-down to the journal entries behind any figure. This
 * proves the DB-touching parts of reports-service.ts (not unit-tested per
 * repo convention) actually compute the right numbers against real posted
 * entries, not just that the pure date-shifting logic in reports.ts is right
 * (that's reports.test.ts's job).
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
let reportsService: typeof import("../src/lib/reports-service");

const biz = { id: "" };
const acct = { cash: "", bankClearing: "", revenue: "", expense: "" };

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
  databaseName = `pos_finstatements_${randomUUID().replaceAll("-", "")}`;

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
  reportsService = await import("../src/lib/reports-service");

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
  // journal_lines.account_id is ON DELETE RESTRICT (not CASCADE), so clear
  // the ledger explicitly before cascading the business away, rather than
  // relying on Postgres's cascade resolution order across the two paths
  // (businesses -> journal_entries -> journal_lines, and businesses -> accounts).
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Statements Co', $1) RETURNING id",
    [`stmt-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'), ($1, '1120', 'Card clearing', 'asset'),
            ($1, '4300', 'Sales', 'revenue'), ($1, '5900', 'Other expense', 'expense')
     RETURNING id, code`,
    [biz.id],
  );
  for (const r of accounts.rows) {
    if (r.code === "1100") acct.cash = r.id;
    if (r.code === "1120") acct.bankClearing = r.id;
    if (r.code === "4300") acct.revenue = r.id;
    if (r.code === "5900") acct.expense = r.id;
  }
});

/** Posts a balanced two-line entry directly, mirroring what postJournalEntry does. */
async function postEntry(entryDate: string, sourceType: string, memo: string, debitAcct: string, creditAcct: string, amount: number) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (business_id, entry_date, memo, source_type)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [biz.id, entryDate, memo, sourceType],
  );
  const entryId = rows[0].id;
  await db.query(
    `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
    [entryId, debitAcct, amount, creditAcct],
  );
  return entryId;
}

describe("getCashFlow", () => {
  it("computes opening/closing cash and groups movements by source type", async () => {
    // Before the period: an order sale that establishes an opening balance.
    await postEntry("2025-03-15", "order", "opening sale", acct.cash, acct.revenue, 500_000);
    // Within the period.
    await postEntry("2025-04-05", "order", "in-period sale", acct.cash, acct.revenue, 300_000);
    await postEntry("2025-04-10", "manual", "cash withdrawal", acct.expense, acct.cash, 100_000);

    const cf = await reportsService.getCashFlow(biz.id, { dateFrom: "2025-04-01", dateTo: "2025-04-30" });

    expect(cf.openingCash).toBe(500_000);
    expect(cf.closingCash).toBe(700_000); // 500,000 + 300,000 - 100,000
    expect(cf.netChange).toBe(200_000);

    const bySource = Object.fromEntries(cf.lines.map((l) => [l.sourceType, l.amount]));
    expect(bySource.order).toBe(300_000);
    expect(bySource.manual).toBe(-100_000);
  });

  it("counts bank-clearing movements as cash too", async () => {
    await postEntry("2025-04-01", "order", "card sale", acct.bankClearing, acct.revenue, 150_000);
    const cf = await reportsService.getCashFlow(biz.id, { dateFrom: "2025-04-01", dateTo: "2025-04-30" });
    expect(cf.closingCash).toBe(150_000);
  });
});

describe("getProfitAndLossComparison", () => {
  it("computes the previous period as the same-length range immediately before", async () => {
    await postEntry("2025-03-10", "order", "march sale", acct.cash, acct.revenue, 400_000);
    await postEntry("2025-04-10", "order", "april sale", acct.cash, acct.revenue, 600_000);

    const cmp = await reportsService.getProfitAndLossComparison(biz.id, {
      dateFrom: "2025-04-01",
      dateTo: "2025-04-30",
    });

    expect(cmp.current.totalRevenue).toBe(600_000);
    expect(cmp.previous).not.toBeNull();
    expect(cmp.previous!.totalRevenue).toBe(400_000);
  });

  it("returns null previous for an open-ended range", async () => {
    const cmp = await reportsService.getProfitAndLossComparison(biz.id, { dateTo: "2025-04-30" });
    expect(cmp.previous).toBeNull();
  });
});

describe("getAccountDrillDown", () => {
  it("returns exactly the journal lines posted to that account in range", async () => {
    const e1 = await postEntry("2025-04-05", "order", "sale one", acct.cash, acct.revenue, 100_000);
    const e2 = await postEntry("2025-04-06", "order", "sale two", acct.cash, acct.revenue, 200_000);
    await postEntry("2025-03-01", "order", "outside range", acct.cash, acct.revenue, 999_000);

    const lines = await reportsService.getAccountDrillDown(biz.id, "4300", {
      dateFrom: "2025-04-01",
      dateTo: "2025-04-30",
    });

    expect(lines).toHaveLength(2);
    const entryIds = lines.map((l) => l.entryId).sort();
    expect(entryIds).toEqual([e1, e2].sort());
    expect(lines.every((l) => l.credit > 0 && l.debit === 0)).toBe(true);
  });
});
