/**
 * Phase 16 scope: "VAT / tax reporting — output vs input VAT, payable
 * position, and a return-shaped report." Output VAT already posts
 * automatically (every order credits vatPayable, since Phase 7); input VAT
 * is recorded via the manual-journal workflow against the new vatReceivable
 * account (migration 0032) rather than built into purchase receiving. This
 * proves getVatReport reads both control accounts correctly: period
 * movement, the net payable/refundable position, and the cumulative
 * balance-to-date that isn't reset by reporting a narrower period.
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
let manualJournal: typeof import("../src/lib/manual-journal-service");

const biz = { id: "" };
const acct = { cash: "", revenue: "", vatPayable: "", vatReceivable: "" };
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
  databaseName = `pos_vat_${randomUUID().replaceAll("-", "")}`;

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
  manualJournal = await import("../src/lib/manual-journal-service");

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
  await db.query("DELETE FROM journal_entry_draft_lines");
  await db.query("DELETE FROM journal_entry_drafts");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('VAT Co', $1) RETURNING id",
    [`vat-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const userRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
    [biz.id],
  );
  user.id = userRow.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'), ($1, '4300', 'Sales', 'revenue'),
            ($1, '2200', 'VAT payable', 'liability'), ($1, '1220', 'VAT receivable', 'asset')
     RETURNING id, code`,
    [biz.id],
  );
  for (const r of accounts.rows) {
    if (r.code === "1100") acct.cash = r.id;
    if (r.code === "4300") acct.revenue = r.id;
    if (r.code === "2200") acct.vatPayable = r.id;
    if (r.code === "1220") acct.vatReceivable = r.id;
  }
});

/** Mirrors an order payment's tax line: Debit Cash / Credit Sales + Credit VAT payable. */
async function postOutputVat(entryDate: string, saleAmount: number, vatAmount: number) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (business_id, entry_date, memo, source_type) VALUES ($1, $2, 'Order', 'order') RETURNING id`,
    [biz.id, entryDate],
  );
  await db.query(`INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $3, 0)`, [
    rows[0].id,
    acct.cash,
    saleAmount + vatAmount,
  ]);
  await db.query(`INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, 0, $3)`, [
    rows[0].id,
    acct.revenue,
    saleAmount,
  ]);
  await db.query(`INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, 0, $3)`, [
    rows[0].id,
    acct.vatPayable,
    vatAmount,
  ]);
}

/** Records input VAT the intended way: a manual journal entry against vatReceivable. */
async function postInputVat(entryDate: string, vatAmount: number) {
  const draft = await manualJournal.createDraft({
    businessId: biz.id,
    locationId: null,
    entryDate,
    memo: "VAT on purchase",
    lines: [
      { accountId: acct.vatReceivable, debit: vatAmount, credit: 0 },
      { accountId: acct.cash, debit: 0, credit: vatAmount },
    ],
    createdBy: user.id,
  });
  await manualJournal.approveDraft({ businessId: biz.id, locationId: null, draftId: draft.id, actorId: user.id });
}

describe("getVatReport", () => {
  it("reports zero for a business with no VAT activity", async () => {
    const report = await reportsService.getVatReport(biz.id, {});
    expect(report).toMatchObject({ outputVat: 0, inputVat: 0, netPayable: 0, vatPayableBalance: 0, vatReceivableBalance: 0 });
  });

  it("nets output VAT against input VAT for the period, both in and out of range", async () => {
    await postOutputVat("2025-04-10", 1_000_000, 90_000);
    await postInputVat("2025-04-12", 30_000);
    await postOutputVat("2025-05-05", 500_000, 45_000); // outside the reported period

    const report = await reportsService.getVatReport(biz.id, { dateFrom: "2025-04-01", dateTo: "2025-04-30" });
    expect(report.outputVat).toBe(90_000);
    expect(report.inputVat).toBe(30_000);
    expect(report.netPayable).toBe(60_000);
  });

  it("is a payable position when output exceeds input, and a refundable one when input exceeds output", async () => {
    await postOutputVat("2025-04-10", 1_000_000, 90_000);
    await postInputVat("2025-04-12", 30_000);
    const payable = await reportsService.getVatReport(biz.id, { dateFrom: "2025-04-01", dateTo: "2025-04-30" });
    expect(payable.netPayable).toBeGreaterThan(0);

    await postInputVat("2025-04-15", 200_000);
    const refundable = await reportsService.getVatReport(biz.id, { dateFrom: "2025-04-01", dateTo: "2025-04-30" });
    expect(refundable.netPayable).toBeLessThan(0);
  });

  it("reports the cumulative account balance as of periodTo, unaffected by a narrower dateFrom", async () => {
    await postOutputVat("2025-04-10", 1_000_000, 90_000);
    await postInputVat("2025-04-12", 30_000);
    await postOutputVat("2025-05-05", 500_000, 45_000);

    // Reporting only April's period movement...
    const aprilOnly = await reportsService.getVatReport(biz.id, { dateFrom: "2025-04-01", dateTo: "2025-04-30" });
    expect(aprilOnly.outputVat).toBe(90_000);
    // ...but the cumulative balance as of the end of April still only reflects April's postings.
    expect(aprilOnly.vatPayableBalance).toBe(90_000);
    expect(aprilOnly.vatReceivableBalance).toBe(30_000);

    // Reporting through the end of May includes both months' cumulative balance.
    const throughMay = await reportsService.getVatReport(biz.id, { dateTo: "2025-05-31" });
    expect(throughMay.vatPayableBalance).toBe(135_000);
  });
});
