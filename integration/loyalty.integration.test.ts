/**
 * Phase 27 Wave 5 — store credit is a real liability, not a column.
 *
 * The load-bearing claims: issuing store credit posts a balanced entry that
 * credits «اعتبار فروشگاهی» (2410, a liability) and debits «برگشت از فروش»
 * (4400, contra-revenue); spending it debits that same liability. Points are a
 * signed ledger over `customer_points`, so earning and redeeming net to zero
 * by construction.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { rialText } from "../src/lib/inventory-exact";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let loyaltyService: typeof import("../src/lib/loyalty-service");

const biz = { id: "", locationId: "" };
const acct = { cash: "", salesReturns: "", storeCreditPayable: "" };

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
  databaseName = `pos_loyalty_${randomUUID().replaceAll("-", "")}`;

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
  loyaltyService = await import("../src/lib/loyalty-service");

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
  await db.query("DELETE FROM customer_points");
  await db.query("DELETE FROM loyalty_programs");
  await db.query("DELETE FROM domain_events");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM customers");
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Loyalty Co', $1, 'cosmetics') RETURNING id",
    [`loyalty-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'),
            ($1, '4400', 'Sales Returns', 'revenue'),
            ($1, '2410', 'Store Credit Payable', 'liability')
     RETURNING id, code`,
    [biz.id],
  );
  for (const row of accounts.rows) {
    if (row.code === "1100") acct.cash = row.id;
    if (row.code === "4400") acct.salesReturns = row.id;
    if (row.code === "2410") acct.storeCreditPayable = row.id;
  }
});

async function createCustomer(name = "مشتری وفادار") {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO customers (business_id, name) VALUES ($1, $2) RETURNING id",
    [biz.id, name],
  );
  return rows[0].id;
}

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

describe("store credit", () => {
  it("appears as a liability when issued, and spending it debits that liability", async () => {
    const customerId = await createCustomer();

    await withClient((client) =>
      loyaltyService.issueStoreCredit(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        customerId,
        amount: 100_000,
        reason: "refund",
      }),
    );

    expect(await loyaltyService.storeCreditBalance(biz.id, customerId)).toBe(100_000);

    // The issue posted Debit Sales Returns / Credit Store Credit Payable.
    const issuedEntry = await db.query<{ entry_id: string }>(
      "SELECT entry_id FROM domain_events WHERE event_type = 'loyalty.store_credit_issued'",
    );
    const { rows: issuedLines } = await db.query<{ account_id: string; debit: string; credit: string }>(
      "SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY debit DESC",
      [issuedEntry.rows[0].entry_id],
    );
    expect(issuedLines).toEqual([
      { account_id: acct.salesReturns, debit: "100000", credit: "0" },
      { account_id: acct.storeCreditPayable, debit: "0", credit: "100000" },
    ]);

    await withClient((client) =>
      loyaltyService.useStoreCredit(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        customerId,
        amount: 60_000,
        paymentMethod: "cash",
      }),
    );

    expect(await loyaltyService.storeCreditBalance(biz.id, customerId)).toBe(40_000);

    const usedEntry = await db.query<{ entry_id: string }>(
      "SELECT entry_id FROM domain_events WHERE event_type = 'loyalty.store_credit_used'",
    );
    const { rows: usedLines } = await db.query<{ account_id: string; debit: string; credit: string }>(
      "SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY debit DESC",
      [usedEntry.rows[0].entry_id],
    );
    expect(usedLines).toEqual([
      { account_id: acct.storeCreditPayable, debit: "60000", credit: "0" },
      { account_id: acct.cash, debit: "0", credit: "60000" },
    ]);
  });

  it("refuses to spend more credit than a customer has", async () => {
    const customerId = await createCustomer();
    await expect(
      withClient((client) =>
        loyaltyService.useStoreCredit(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          customerId,
          amount: 1,
          paymentMethod: "cash",
        }),
      ),
    ).rejects.toThrow(/اعتبار/);
  });
});

describe("points", () => {
  it("nets earn and redeem to zero in the points ledger", async () => {
    const customerId = await createCustomer();
    await loyaltyService.upsertProgram(biz.id, {
      name: "پیش‌فرض",
      earnPointsPer100000: 1,
      pointValueRial: 1000,
      isDefault: true,
    });

    // Earn 10 points on a 1,000,000 Rial sale (10 × 100,000).
    await withClient((client) =>
      loyaltyService.earnPoints(client, {
        businessId: biz.id,
        customerId,
        amountRial: rialText("1000000"),
        sourceType: "test",
        sourceId: randomUUID(),
      }),
    );
    expect(await loyaltyService.pointsBalance(biz.id, customerId)).toBe(10);

    // Redeem them all: -10 points, and store credit of 10 × 1000 Rial issued.
    await withClient((client) =>
      loyaltyService.redeemPoints(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        customerId,
        points: 10,
      }),
    );

    expect(await loyaltyService.pointsBalance(biz.id, customerId)).toBe(0);
    expect(await loyaltyService.storeCreditBalance(biz.id, customerId)).toBe(10_000);
  });

  it("refuses to redeem more points than the balance", async () => {
    const customerId = await createCustomer();
    await loyaltyService.upsertProgram(biz.id, {
      name: "پیش‌فرض",
      earnPointsPer100000: 1,
      pointValueRial: 1000,
      isDefault: true,
    });

    await expect(
      withClient((client) =>
        loyaltyService.redeemPoints(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          customerId,
          points: 5,
        }),
      ),
    ).rejects.toThrow(/امتیاز/);
  });
});
