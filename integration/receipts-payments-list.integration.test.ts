/**
 * «دریافت‌ها / پرداخت‌ها» — the voucher lists behind the ledger's receipts and
 * payments slice. The search used to run in JavaScript after pulling the whole
 * table (and matched the raw string), so typing Arabic-script «علي» missed a
 * customer stored with Persian «علی», and «%» swallowed the entire list as a
 * LIKE wildcard. The filter now runs in SQL with the same normalization the
 * app's pickers use and with wildcards escaped — this pins both.
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
let installments: typeof import("../src/lib/installments-service");

const biz = { id: "", locationId: "" };

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
  databaseName = `pos_vouchers_${randomUUID().replaceAll("-", "")}`;

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
  installments = await import("../src/lib/installments-service");

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

async function addCustomer(name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, role, is_active) VALUES ($1, $2, 'customer', true) RETURNING id`,
    [biz.id, name],
  );
  return rows[0].id;
}

async function addReceipt(customerId: string, amount: number, date: string, memo: string | null): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO ar_receipts (business_id, customer_id, receipt_date, method, amount, memo)
     VALUES ($1, $2, $3, 'cash', $4, $5) RETURNING id`,
    [biz.id, customerId, date, amount, memo],
  );
  return rows[0].id;
}

async function addSupplier(name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO suppliers (location_id, name, is_active) VALUES ($1, $2, true) RETURNING id`,
    [biz.locationId, name],
  );
  return rows[0].id;
}

async function addPayment(supplierId: string, amount: number, date: string, memo: string | null): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO ap_payments (business_id, supplier_id, payment_date, method, amount, memo)
     VALUES ($1, $2, $3, 'bank', $4, $5) RETURNING id`,
    [biz.id, supplierId, date, amount, memo],
  );
  return rows[0].id;
}

beforeEach(async () => {
  await db.query("DELETE FROM ar_receipts");
  await db.query("DELETE FROM ap_payments");
  await db.query("DELETE FROM suppliers");
  await db.query("DELETE FROM parties");
  await db.query("DELETE FROM locations");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Voucher Co', $1) RETURNING id",
    [`vouchers-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;
});

describe("listReceipts", () => {
  it("lists every receipt newest-first, regardless of party", async () => {
    const a = await addCustomer("علی رضایی");
    const b = await addCustomer("سارا محمدی");
    await addReceipt(a, 100, "2026-09-10", null);
    await addReceipt(b, 200, "2026-09-15", "تسویه");
    await addReceipt(a, 300, "2026-09-16", null);

    const rows = await installments.listReceipts(biz.id);
    expect(rows.map((r) => r.amount)).toEqual([300, 200, 100]);
    expect(rows[1].partyName).toBe("سارا محمدی");
  });

  it("filters by party name and by memo", async () => {
    const a = await addCustomer("علی رضایی");
    const b = await addCustomer("سارا محمدی");
    await addReceipt(a, 100, "2026-09-10", "بابت فاکتور ۱۲");
    await addReceipt(b, 200, "2026-09-11", "پیش‌پرداخت");

    expect((await installments.listReceipts(biz.id, "علی")).map((r) => r.amount)).toEqual([100]);
    expect((await installments.listReceipts(biz.id, "پیش‌پرداخت")).map((r) => r.amount)).toEqual([200]);
    expect(await installments.listReceipts(biz.id, "چیزی که نیست")).toEqual([]);
  });

  it("folds Arabic ي/ك and both digit sets, like the app's pickers do", async () => {
    // Stored with Persian letters; searched with Arabic-script ones.
    const a = await addCustomer("علی کریمی");
    await addReceipt(a, 100, "2026-09-10", "فیش ۶۰۳۷");
    await addReceipt(a, 200, "2026-09-11", null);

    // Both rows match on the name alone; the order stays newest-first.
    expect((await installments.listReceipts(biz.id, "علي كر")).map((r) => r.amount)).toEqual([200, 100]);
    // The memo holds Persian digits; the Latin-digit needle must still find it.
    expect((await installments.listReceipts(biz.id, "6037")).map((r) => r.amount)).toEqual([100]);
    expect((await installments.listReceipts(biz.id, "۶۰۳۷")).map((r) => r.amount)).toEqual([100]);
  });

  it("treats LIKE wildcards as literals, not patterns", async () => {
    const a = await addCustomer("علی رضایی");
    const b = await addCustomer("شرکت 100% بازرگانی");
    await addReceipt(a, 100, "2026-09-10", "تسویه");
    await addReceipt(b, 200, "2026-09-10", "تخفیف 50%");

    // «%» must not become the match-everything wildcard — only the literal hit lists.
    expect((await installments.listReceipts(biz.id, "%")).map((r) => r.amount)).toEqual([200]);
    // …even when the needle is typed with Persian digits (folded to Latin first).
    expect((await installments.listReceipts(biz.id, "۵۰%")).map((r) => r.amount)).toEqual([200]);
    // «_» in the needle is a literal too — it would otherwise match «علی رضایی».
    expect(await installments.listReceipts(biz.id, "ع_ی")).toEqual([]);
  });
});

describe("listPayments", () => {
  it("lists payments and resolves the supplier alias name", async () => {
    const s = await addSupplier("پخش مواد غذایی آسمان");
    await addPayment(s, 900, "2026-09-09", "قبوض شهریور");
    await addPayment(s, 400, "2026-09-16", null);

    const rows = await installments.listPayments(biz.id);
    expect(rows.map((r) => r.amount)).toEqual([400, 900]);
    expect(rows[0].partyName).toBe("پخش مواد غذایی آسمان");

    expect((await installments.listPayments(biz.id, "آسمان")).map((r) => r.amount)).toEqual([400, 900]);
    expect((await installments.listPayments(biz.id, "قبوض")).map((r) => r.amount)).toEqual([900]);
  });
});
