/**
 * Phase 27 Wave 7 — sales-staff commission is a payroll liability, not a
 * report-only number.
 *
 * The load-bearing claims: a settled line accrues commission to the selling
 * employee per the most specific matching rule, and the accrual posts Debit
 * «پورسانت فروش» (5210) / Credit «حقوق پرداختنی» (2300) through the domain
 * engine. A margin-basis rule uses the same cost the COGS posting used, and
 * the per-staff report is a SUM of the signed accruals.
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
let commissionService: typeof import("../src/lib/commission-service");

const biz = { id: "", locationId: "" };
const acct = { commissionExpense: "", salariesPayable: "" };
const employee = { id: "" };

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
  databaseName = `pos_commission_${randomUUID().replaceAll("-", "")}`;

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
  commissionService = await import("../src/lib/commission-service");

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
  await db.query("DELETE FROM commission_accruals");
  await db.query("DELETE FROM commission_rules");
  await db.query("DELETE FROM domain_events");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM users");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Commission Co', $1, 'cosmetics') RETURNING id",
    [`commission-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;

  const empRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'cashier', 'فروشنده نمونه', 'x') RETURNING id`,
    [biz.id],
  );
  employee.id = empRow.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '5210', 'Commission expense', 'expense'), ($1, '2300', 'Salaries payable', 'liability')
     RETURNING id, code`,
    [biz.id],
  );
  for (const row of accounts.rows) {
    if (row.code === "5210") acct.commissionExpense = row.id;
    if (row.code === "2300") acct.salariesPayable = row.id;
  }
});

async function withClient<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await dbLib.getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

describe("commission accrual", () => {
  it("accrues a percent of net and posts the payroll liability", async () => {
    await commissionService.upsertCommissionRule(biz.id, {
      employeeId: employee.id,
      kind: "percent",
      basis: "net",
      value: 5,
    });

    await withClient((client) =>
      commissionService.accrueCommissionForLine(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        employeeId: employee.id,
        sourceType: "order_item",
        sourceId: randomUUID(),
        line: { net: 100_000, cost: 40_000, itemId: randomUUID() },
      }),
    );

    // 5% of 100,000 = 5,000, posted Debit 5210 / Credit 2300.
    const entry = await db.query<{ entry_id: string }>(
      "SELECT entry_id FROM domain_events WHERE event_type = 'commission.accrued'",
    );
    const { rows: lines } = await db.query<{ account_id: string; debit: string; credit: string }>(
      "SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY debit DESC",
      [entry.rows[0].entry_id],
    );
    expect(lines).toEqual([
      { account_id: acct.commissionExpense, debit: "5000", credit: "0" },
      { account_id: acct.salariesPayable, debit: "0", credit: "5000" },
    ]);

    const report = await commissionService.staffCommissionReport(biz.id);
    expect(report).toHaveLength(1);
    expect(report[0].employeeName).toBe("فروشنده نمونه");
    expect(report[0].amount).toBe(5000);
    expect(report[0].lineCount).toBe(1);
  });

  it("computes a margin-basis rule on net minus cost", async () => {
    await commissionService.upsertCommissionRule(biz.id, {
      employeeId: employee.id,
      kind: "percent",
      basis: "margin",
      value: 10,
    });

    await withClient((client) =>
      commissionService.accrueCommissionForLine(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        employeeId: employee.id,
        sourceType: "order_item",
        sourceId: randomUUID(),
        line: { net: 100_000, cost: 40_000, itemId: randomUUID() },
      }),
    );

    // 10% of (100,000 − 40,000) = 6,000.
    const report = await commissionService.staffCommissionReport(biz.id);
    expect(report[0].amount).toBe(6000);
    expect(report[0].basisAmount).toBe(60_000);
  });

  it("accrues nothing when no rule matches the selling employee", async () => {
    await commissionService.upsertCommissionRule(biz.id, {
      employeeId: employee.id,
      kind: "percent",
      basis: "net",
      value: 5,
      itemIds: [randomUUID()],
    });

    await withClient((client) =>
      commissionService.accrueCommissionForLine(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        employeeId: employee.id,
        sourceType: "order_item",
        sourceId: randomUUID(),
        // A different item than the rule scopes.
        line: { net: 100_000, cost: 40_000, itemId: randomUUID() },
      }),
    );

    const report = await commissionService.staffCommissionReport(biz.id);
    expect(report).toHaveLength(0);
  });

  it("picks the most specific matching rule", async () => {
    const itemId = randomUUID();
    await commissionService.upsertCommissionRule(biz.id, {
      employeeId: employee.id,
      kind: "percent",
      basis: "net",
      value: 2,
    });
    await commissionService.upsertCommissionRule(biz.id, {
      employeeId: employee.id,
      kind: "percent",
      basis: "net",
      value: 7,
      itemIds: [itemId],
    });

    await withClient((client) =>
      commissionService.accrueCommissionForLine(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        employeeId: employee.id,
        sourceType: "order_item",
        sourceId: randomUUID(),
        line: { net: 100_000, cost: 0, itemId },
      }),
    );

    // The item-scoped 7% beats the catch-all 2%.
    const report = await commissionService.staffCommissionReport(biz.id);
    expect(report[0].amount).toBe(7000);
  });

  it("refuses to name an employee from another business", async () => {
    const otherBiz = await db.query<{ id: string }>(
      `INSERT INTO businesses (name, slug) VALUES ('Other', $1) RETURNING id`,
      [`other-${randomUUID().slice(0, 8)}`],
    );
    const otherUser = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Other', 'x') RETURNING id`,
      [otherBiz.rows[0].id],
    );

    await expect(
      commissionService.upsertCommissionRule(biz.id, {
        employeeId: otherUser.rows[0].id,
        kind: "percent",
        basis: "net",
        value: 5,
      }),
    ).rejects.toThrow(/فروشنده/);
  });
});
