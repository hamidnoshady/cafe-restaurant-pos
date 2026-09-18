/**
 * Splitting one bill across several payment ways (migration 0091).
 *
 * Two halves, both of which only exist against a real database:
 *
 *  1. the posting — a split has to produce *one* entry with a debit line per
 *     way and a single revenue credit, still balanced, with SnapFood's
 *     commission taken out of the SnapFood slice alone;
 *  2. the ways themselves — seeded per business by the migration, isolated by
 *     RLS, and refusing to let a way that has taken money be deleted.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import type { RialText } from "../src/lib/inventory-exact";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let ledgerService: typeof import("../src/lib/ledger-service");
let paymentMethodsService: typeof import("../src/lib/payment-methods-service");

const biz = { id: "", locationId: "" };
const acct = {
  cash: "",
  bankClearing: "",
  accountsReceivable: "",
  platformReceivable: "",
  dineIn: "",
  takeaway: "",
  delivery: "",
  vatPayable: "",
  tipsPayable: "",
  platformCommissionExpense: "",
};

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
  databaseName = `pos_split_pay_${randomUUID().replaceAll("-", "")}`;

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
  ledgerService = await import("../src/lib/ledger-service");
  paymentMethodsService = await import("../src/lib/payment-methods-service");

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

async function seedBusiness(name: string): Promise<{ id: string; locationId: string }> {
  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    [name, `split-${randomUUID().slice(0, 8)}`],
  );
  const id = bizRow.rows[0].id;
  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [id],
  );
  return { id, locationId: locRow.rows[0].id };
}

beforeEach(async () => {
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM payments");
  await db.query("DELETE FROM inventory_events");
  await db.query("DELETE FROM businesses");

  const seeded = await seedBusiness("Split Pay Co");
  biz.id = seeded.id;
  biz.locationId = seeded.locationId;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'), ($1, '1120', 'Card clearing', 'asset'),
            ($1, '1200', 'Accounts Receivable', 'asset'),
            ($1, '1230', 'Platform Receivable', 'asset'),
            ($1, '4310', 'Dine-in', 'revenue'),
            ($1, '4320', 'Takeaway', 'revenue'), ($1, '4330', 'Delivery', 'revenue'),
            ($1, '2200', 'VAT Payable', 'liability'), ($1, '2400', 'Tips Payable', 'liability'),
            ($1, '5650', 'Platform Commission Expense', 'expense')
     RETURNING id, code`,
    [biz.id],
  );
  const byCode: Record<string, keyof typeof acct> = {
    "1100": "cash",
    "1120": "bankClearing",
    "1200": "accountsReceivable",
    "1230": "platformReceivable",
    "4310": "dineIn",
    "4320": "takeaway",
    "4330": "delivery",
    "2200": "vatPayable",
    "2400": "tipsPayable",
    "5650": "platformCommissionExpense",
  };
  for (const row of accounts.rows) acct[byCode[row.code]] = row.id;
});

async function newInventoryEventId(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO inventory_events (business_id, location_id, event_type, source_type, source_id)
     VALUES ($1, $2, 'sale_consumption', 'order', $3) RETURNING id`,
    [biz.id, biz.locationId, randomUUID()],
  );
  return rows[0].id;
}

type PostParams = Parameters<typeof ledgerService.postExactOrderPaymentEntry>[1];

async function post(params: Omit<PostParams, "businessId" | "locationId" | "orderId" | "createdBy" | "inventoryEventId">) {
  const inventoryEventId = await newInventoryEventId();
  const client = await dbLib.getPool().connect();
  try {
    await client.query("BEGIN");
    const entryId = await ledgerService.postExactOrderPaymentEntry(client, {
      businessId: biz.id,
      locationId: biz.locationId,
      orderId: randomUUID(),
      createdBy: null,
      inventoryEventId,
      ...params,
    } as PostParams);
    await client.query("COMMIT");
    return entryId;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function linesOf(entryId: string | null) {
  const { rows } = await db.query<{ account_id: string; debit: string; credit: string }>(
    // ctid is insertion order for a set of rows just written — which is what
    // lets these tests assert the *order* of the debit lines (the order the
    // cashier took the tenders in), not merely the set of them.
    "SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY ctid",
    [entryId],
  );
  return rows;
}

describe("postExactOrderPaymentEntry — a bill split across payment ways", () => {
  it("posts one entry with a debit line per way and a single revenue credit", async () => {
    const entryId = await post({
      tenders: [
        { settlement: "cash", amount: "40000" as RialText },
        { settlement: "card", amount: "70000" as RialText },
      ],
      amount: "110000" as RialText,
      tax: "10000" as RialText,
      orderChannel: "dine_in",
    });

    expect(await linesOf(entryId)).toEqual([
      { account_id: acct.cash, debit: "40000", credit: "0" },
      { account_id: acct.bankClearing, debit: "70000", credit: "0" },
      { account_id: acct.dineIn, debit: "0", credit: "100000" },
      { account_id: acct.vatPayable, debit: "0", credit: "10000" },
    ]);
  });

  it("merges two ways that settle to the same account into one line", async () => {
    // A card terminal and a card-to-card transfer both land in bank clearing;
    // an entry naming that account twice on the same side reads as a duplicate.
    const entryId = await post({
      tenders: [
        { settlement: "card", amount: "30000" as RialText },
        { settlement: "card_to_card", amount: "20000" as RialText },
      ],
      amount: "50000" as RialText,
      tax: "0" as RialText,
      orderChannel: "takeaway",
    });

    expect(await linesOf(entryId)).toEqual([
      { account_id: acct.bankClearing, debit: "50000", credit: "0" },
      { account_id: acct.takeaway, debit: "0", credit: "50000" },
    ]);
  });

  it("debits the tip on top, on the first slice that collected money", async () => {
    const entryId = await post({
      tenders: [
        // The route folds the tip in through tendersWithTip before posting;
        // here that is the 40,000 cash slice carrying a 5,000 tip.
        { settlement: "cash", amount: "45000" as RialText },
        { settlement: "card", amount: "70000" as RialText },
      ],
      amount: "110000" as RialText,
      tax: "10000" as RialText,
      tip: "5000" as RialText,
      orderChannel: "dine_in",
    });

    expect(await linesOf(entryId)).toEqual([
      { account_id: acct.cash, debit: "45000", credit: "0" },
      { account_id: acct.bankClearing, debit: "70000", credit: "0" },
      { account_id: acct.dineIn, debit: "0", credit: "100000" },
      { account_id: acct.vatPayable, debit: "0", credit: "10000" },
      { account_id: acct.tipsPayable, debit: "0", credit: "5000" },
    ]);
  });

  it("takes SnapFood's commission out of the SnapFood slice, not the cash one", async () => {
    const entryId = await post({
      tenders: [
        { settlement: "snappfood", amount: "80000" as RialText },
        { settlement: "cash", amount: "20000" as RialText },
      ],
      amount: "100000" as RialText,
      tax: "0" as RialText,
      // 20% of the 80,000 that actually came through SnapFood.
      platformCommission: "16000" as RialText,
      orderChannel: "delivery",
    });

    expect(await linesOf(entryId)).toEqual([
      { account_id: acct.platformReceivable, debit: "64000", credit: "0" },
      { account_id: acct.cash, debit: "20000", credit: "0" },
      { account_id: acct.platformCommissionExpense, debit: "16000", credit: "0" },
      { account_id: acct.delivery, debit: "0", credit: "100000" },
    ]);
  });

  it("refuses a split that does not add up to the bill", async () => {
    await expect(
      post({
        tenders: [
          { settlement: "cash", amount: "40000" as RialText },
          { settlement: "card", amount: "50000" as RialText },
        ],
        amount: "110000" as RialText,
        tax: "0" as RialText,
        orderChannel: "dine_in",
      }),
    ).rejects.toThrow("tender_total_mismatch");
  });

  it("still posts a single-method payment exactly as it always did", async () => {
    const entryId = await post({
      method: "cash",
      amount: "110000" as RialText,
      tax: "10000" as RialText,
      orderChannel: "dine_in",
    });

    expect(await linesOf(entryId)).toEqual([
      { account_id: acct.cash, debit: "110000", credit: "0" },
      { account_id: acct.dineIn, debit: "0", credit: "100000" },
      { account_id: acct.vatPayable, debit: "0", credit: "10000" },
    ]);
  });

  it("posts nothing for a comped, zero-total order", async () => {
    const entryId = await post({
      method: "cash",
      amount: "0" as RialText,
      tax: "0" as RialText,
      orderChannel: "dine_in",
    });
    expect(entryId).toBeNull();
  });
});

describe("payment ways", () => {
  it("seeds the built-in ways for a business, in the order the till shows them", async () => {
    const methods = await dbLib.withTenant(biz.id, () => paymentMethodsService.listPaymentMethods(biz.id));
    expect(methods.map((method) => method.code)).toEqual(["cash", "card", "card_to_card", "online", "credit", "snappfood"]);
    expect(methods.every((method) => method.isBuiltin)).toBe(true);
    expect(methods.filter((method) => method.opensDrawer).map((method) => method.code)).toEqual(["cash"]);
  });

  it("never shows one business the ways of another", async () => {
    const other = await seedBusiness("Other Co");
    await dbLib.withTenant(other.id, () =>
      paymentMethodsService.createPaymentMethod(other.id, {
        name: "کیف پول همسایه",
        settlement: "online",
        opensDrawer: false,
        requiresReference: false,
      }),
    );

    const mine = await dbLib.withTenant(biz.id, () => paymentMethodsService.listPaymentMethods(biz.id));
    expect(mine.map((method) => method.name)).not.toContain("کیف پول همسایه");
  });

  it("adds a way at the end of the grid and hands it a free code", async () => {
    const added = await dbLib.withTenant(biz.id, () =>
      paymentMethodsService.createPaymentMethod(biz.id, {
        name: "پوز بانک ملت",
        settlement: "card",
        opensDrawer: false,
        requiresReference: true,
      }),
    );
    const methods = await dbLib.withTenant(biz.id, () => paymentMethodsService.listPaymentMethods(biz.id));

    expect(added.isBuiltin).toBe(false);
    expect(added.requiresReference).toBe(true);
    expect(methods.at(-1)?.id).toBe(added.id);
  });

  it("reorders the whole grid at once", async () => {
    const before = await dbLib.withTenant(biz.id, () => paymentMethodsService.listPaymentMethods(biz.id));
    const reversed = [...before].reverse().map((method) => method.id);
    await dbLib.withTenant(biz.id, () => paymentMethodsService.reorderPaymentMethods(biz.id, reversed));

    const after = await dbLib.withTenant(biz.id, () => paymentMethodsService.listPaymentMethods(biz.id));
    expect(after.map((method) => method.id)).toEqual(reversed);
  });

  it("rejects an incomplete or duplicated order without changing the grid", async () => {
    const before = await dbLib.withTenant(biz.id, () => paymentMethodsService.listPaymentMethods(biz.id));
    const incomplete = before.slice(1).map((method) => method.id);
    const duplicated = before.map((method, index) => (index === 0 ? before[1].id : method.id));

    expect(
      await dbLib.withTenant(biz.id, () => paymentMethodsService.reorderPaymentMethods(biz.id, incomplete)),
    ).toBe(false);
    expect(
      await dbLib.withTenant(biz.id, () => paymentMethodsService.reorderPaymentMethods(biz.id, duplicated)),
    ).toBe(false);

    const after = await dbLib.withTenant(biz.id, () => paymentMethodsService.listPaymentMethods(biz.id));
    expect(after.map((method) => method.id)).toEqual(before.map((method) => method.id));
  });

  it("keeps a deactivated way off the till but on its old payments", async () => {
    const methods = await dbLib.withTenant(biz.id, () => paymentMethodsService.listPaymentMethods(biz.id));
    const credit = methods.find((method) => method.code === "credit")!;

    const orderRow = await db.query<{ id: string }>(
      `INSERT INTO orders (location_id, order_number, type, status, subtotal, discount, tax, total)
       VALUES ($1, 1, 'dine_in', 'completed', 100000, 0, 0, 100000) RETURNING id`,
      [biz.locationId],
    );
    await db.query(
      `INSERT INTO payments (location_id, order_id, method, amount, payment_method_id)
       VALUES ($1, $2, 'credit', 100000, $3)`,
      [biz.locationId, orderRow.rows[0].id, credit.id],
    );

    await dbLib.withTenant(biz.id, () => paymentMethodsService.updatePaymentMethod(biz.id, credit.id, { isActive: false }));

    const offered = await dbLib.withTenant(biz.id, () => paymentMethodsService.listPaymentMethods(biz.id));
    expect(offered.map((method) => method.code)).not.toContain("credit");

    const used = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM payments WHERE payment_method_id = $1",
      [credit.id],
    );
    expect(used.rows[0].count).toBe("1");
    expect(await dbLib.withTenant(biz.id, () => paymentMethodsService.paymentCountForMethod(biz.id, credit.id))).toBe(1);
  });

  it("refuses to delete a built-in way", async () => {
    const methods = await dbLib.withTenant(biz.id, () => paymentMethodsService.listPaymentMethods(biz.id));
    const cash = methods.find((method) => method.code === "cash")!;
    expect(await dbLib.withTenant(biz.id, () => paymentMethodsService.deletePaymentMethod(biz.id, cash.id))).toBe(false);
  });

  it("deletes a way the business added and never used", async () => {
    const added = await dbLib.withTenant(biz.id, () =>
      paymentMethodsService.createPaymentMethod(biz.id, {
        name: "کیف پول",
        settlement: "online",
        opensDrawer: false,
        requiresReference: false,
      }),
    );
    expect(await dbLib.withTenant(biz.id, () => paymentMethodsService.deletePaymentMethod(biz.id, added.id))).toBe(true);
  });
});

/**
 * The rows themselves, against the real table.
 *
 * Everything above this point tests the arithmetic and the ways; none of it
 * writes two live `payments` rows for one order, which is exactly how migration
 * 0091 shipped with `uq_payments_one_positive_per_order` still forbidding the
 * second slice of every split. Migration 0092 re-expressed that index as "one
 * live *settlement* per order" — these two tests are what would have caught it.
 */
describe("payments rows for a split bill", () => {
  let nextOrderNumber = 9000;

  async function openOrder(): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO orders (location_id, order_number, type, status, subtotal, discount, tax, total)
       VALUES ($1, $2, 'dine_in', 'open', 500000, 0, 0, 500000)
       RETURNING id`,
      [biz.locationId, ++nextOrderNumber],
    );
    return rows[0].id;
  }

  it("accepts one checkout's several slices", async () => {
    const orderId = await openOrder();
    await db.query(
      `INSERT INTO payments (location_id, order_id, method, amount, settlement_seq)
       VALUES ($1, $2, 'cash', 200000, 1), ($1, $2, 'card', 300000, 2)`,
      [biz.locationId, orderId],
    );
    const { rows } = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM payments WHERE order_id = $1",
      [orderId],
    );
    expect(rows[0].count).toBe("2");
  });

  it("still refuses a second, concurrent settlement of the same bill", async () => {
    const orderId = await openOrder();
    await db.query(
      `INSERT INTO payments (location_id, order_id, method, amount, settlement_seq)
       VALUES ($1, $2, 'cash', 200000, 1), ($1, $2, 'card', 300000, 2)`,
      [biz.locationId, orderId],
    );
    // A rival checkout numbers its own slices from 1 and collides on the first.
    await expect(
      db.query(
        `INSERT INTO payments (location_id, order_id, method, amount, settlement_seq)
         VALUES ($1, $2, 'cash', 500000, 1)`,
        [biz.locationId, orderId],
      ),
    ).rejects.toThrow(/uq_payments_one_positive_per_order/);
  });
});
