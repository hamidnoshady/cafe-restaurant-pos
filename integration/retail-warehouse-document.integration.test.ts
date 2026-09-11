/**
 * Phase 42b — retail warehouse documents (رسید/حواله انبار) on the
 * items/item_stock/item_batches model.
 *
 * The load-bearing claims: a receipt upserts the lot (re-averaging it) and
 * rolls item_stock to the 0078 invariant while posting Debit {industry}
 * inventory / Credit other income; an issue relieves the named lot at the
 * lot's own cost and posts Debit other expense / Credit inventory; and every
 * refusal path holds — short stock, missing lot, over-lot, serial and weight
 * items, a supplier on the document, and another tenant's or branch's rows.
 *
 * Template: per-test BEGIN/ROLLBACK over the shared pool (the Phase 42
 * warehouse-document suite's shape), a real cosmetics chart of accounts via
 * provisioning.seedChartOfAccounts, and the four item kinds the retail model
 * carries (plain, batch, serial, weight).
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let itemsService: typeof import("../src/lib/items-service");
let provisioning: typeof import("../src/lib/business-provisioning");
let warehouseService: typeof import("../src/lib/retail-warehouse-document-service");

const biz = { id: "", locationId: "", otherLocationId: "", otherBizId: "", otherBizLocationId: "" };
const acct = { inventory: "", otherIncome: "", otherExpense: "" };
const item = { plainId: "", batchId: "", serialId: "", weightId: "", otherBranchPlainId: "" };

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
  databaseName = `pos_rwhdoc_${randomUUID().replaceAll("-", "")}`;

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
  itemsService = await import("../src/lib/items-service");
  provisioning = await import("../src/lib/business-provisioning");
  warehouseService = await import("../src/lib/retail-warehouse-document-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  // --- the committed base fixture every test's transaction starts from ---
  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Retail Warehouse Co', $1, 'cosmetics') RETURNING id",
    [`rwhdoc-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'انبار مرکزی'), ($1, 'انبار فرعی') RETURNING id`,
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;
  biz.otherLocationId = locRow.rows[1].id;

  // A second business with its own location — the tenant-isolation probe.
  const otherBizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Other Trade Co', $1, 'cosmetics') RETURNING id",
    [`other-${randomUUID().slice(0, 8)}`],
  );
  biz.otherBizId = otherBizRow.rows[0].id;
  const otherLocRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'انبار دیگران') RETURNING id",
    [biz.otherBizId],
  );
  biz.otherBizLocationId = otherLocRow.rows[0].id;

  // Seeded from the real cosmetics template rather than hand-inserted, so a
  // missing 1350/4900/5900 would fail here instead of silently never posting.
  const seedClient = await dbLib.getPool().connect();
  try {
    await provisioning.seedChartOfAccounts(seedClient, biz.id, "cosmetics");
  } finally {
    seedClient.release();
  }
  const accounts = await db.query<{ id: string; code: string }>(
    `SELECT id, code FROM accounts WHERE business_id = $1 AND code IN ('1350', '4900', '5900')`,
    [biz.id],
  );
  for (const row of accounts.rows) {
    if (row.code === "1350") acct.inventory = row.id;
    if (row.code === "4900") acct.otherIncome = row.id;
    if (row.code === "5900") acct.otherExpense = row.id;
  }
  expect(acct.inventory).not.toBe("");
  expect(acct.otherIncome).not.toBe("");
  expect(acct.otherExpense).not.toBe("");

  // The four item kinds the retail model carries.
  item.plainId = (await itemsService.createItem({ locationId: biz.locationId, name: "لوسیون دست", tracking: "none" })).id;
  item.batchId = (await itemsService.createItem({ locationId: biz.locationId, name: "کرم ضدآفتاب", tracking: "batch" })).id;
  item.serialId = (await itemsService.createItem({ locationId: biz.locationId, name: "ساعت مچی", tracking: "serial" })).id;
  item.weightId = (await itemsService.createItem({ locationId: biz.locationId, name: "گردنبند طلا", tracking: "weight" })).id;
  item.otherBranchPlainId = (await itemsService.createItem({ locationId: biz.otherLocationId, name: "لوسیون دست (انبار فرعی)", tracking: "none" })).id;
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

/** One test's transaction: BEGIN, run, ROLLBACK — nothing a test writes survives it. */
async function withClient<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await dbLib.getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("ROLLBACK");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

type Line = {
  itemId: string;
  quantity: string;
  unitCost?: number;
  lot?: string | null;
  expiryDate?: string | null;
};

/** Seeds a posted document the same way the API does. */
async function createDoc(
  client: import("pg").PoolClient,
  input: {
    kind: "receipt" | "issue";
    lines: Line[];
    locationId?: string;
    businessId?: string;
    supplierId?: string | null;
    documentNumber?: string | null;
  },
) {
  const parsed = warehouseService.parseRetailWarehouseDocumentLines(input.kind, input.lines);
  return warehouseService.createRetailWarehouseDocumentInTransaction(client, {
    businessId: input.businessId ?? biz.id,
    locationId: input.locationId ?? biz.locationId,
    kind: parsed.kind,
    supplierId: input.supplierId ?? null,
    recipient: input.kind === "issue" ? "مقصد آزمون" : null,
    documentNumber: input.documentNumber ?? null,
    note: null,
    createdBy: null,
    lines: parsed.lines,
  });
}

async function glBalances(client: import("pg").PoolClient) {
  const { rows } = await client.query<{ inventory_gl: string; other_income_gl: string; other_expense_gl: string }>(
    `SELECT
       (SELECT COALESCE(sum(jl.debit-jl.credit),0)::text FROM journal_lines jl
         JOIN accounts a ON a.id=jl.account_id WHERE a.business_id=$1 AND a.code='1350') inventory_gl,
       (SELECT COALESCE(sum(jl.debit-jl.credit),0)::text FROM journal_lines jl
         JOIN accounts a ON a.id=jl.account_id WHERE a.business_id=$1 AND a.code='4900') other_income_gl,
       (SELECT COALESCE(sum(jl.debit-jl.credit),0)::text FROM journal_lines jl
         JOIN accounts a ON a.id=jl.account_id WHERE a.business_id=$1 AND a.code='5900') other_expense_gl`,
    [biz.id],
  );
  return rows[0];
}

interface LedgerRow {
  batch_qty: string | null;
  batch_cost: string | null;
  stock_qty: string | null;
  stock_cost: string | null;
}

/** The batch ledger vs the item_stock rollup, for the 0078 invariant. */
async function batchLedger(client: import("pg").PoolClient, itemId: string): Promise<LedgerRow> {
  const { rows } = await client.query<LedgerRow>(
    `SELECT (SELECT trim_scale(COALESCE(sum(quantity),0))::text FROM item_batches WHERE item_id=$1) batch_qty,
            (SELECT trim_scale(COALESCE(sum(quantity*unit_cost),0))::text FROM item_batches WHERE item_id=$1) batch_cost,
            (SELECT trim_scale(quantity)::text FROM item_stock WHERE item_id=$1) stock_qty,
            (SELECT unit_cost::text FROM item_stock WHERE item_id=$1) stock_cost`,
    [itemId],
  );
  return rows[0];
}

describe("retail warehouse documents (رسید/حواله انبار)", () => {
  it("posts a receipt: Debit 1350 / Credit 4900, stock in on both item kinds", async () => {
    await withClient(async (client) => {
      const created = await createDoc(client, {
        kind: "receipt",
        lines: [
          { itemId: item.plainId, quantity: "10", unitCost: 50_000 },
          { itemId: item.batchId, quantity: "4", unitCost: 120_000, lot: "LOT-A", expiryDate: "2027-03-01" },
        ],
      });
      expect(created.debitCode).toBe("1350");
      expect(created.creditCode).toBe("4900");
      expect(created.entryId).not.toBeNull();
      // 10×50,000 + 4×120,000 = 980,000.
      expect(created.totalValue).toBe("980000");

      // Stock landed: the plain item on item_stock, the batch item as a lot.
      const plain = await client.query<{ quantity: string; unit_cost: string }>(
        "SELECT trim_scale(quantity)::text AS quantity, unit_cost::text FROM item_stock WHERE item_id = $1",
        [item.plainId],
      );
      expect(plain.rows[0].quantity).toBe("10");
      expect(plain.rows[0].unit_cost).toBe("50000");

      const batch = await client.query<{ quantity: string; unit_cost: string; expiry_date: string | null }>(
        "SELECT trim_scale(quantity)::text AS quantity, unit_cost::text, expiry_date::text FROM item_batches WHERE item_id = $1 AND batch_number = 'LOT-A'",
        [item.batchId],
      );
      expect(batch.rows[0].quantity).toBe("4");
      expect(batch.rows[0].unit_cost).toBe("120000");
      expect(batch.rows[0].expiry_date).toBe("2027-03-01");

      const bal = await glBalances(client);
      expect(bal.inventory_gl).toBe("980000");
      expect(bal.other_income_gl).toBe("-980000");
      expect(bal.other_expense_gl).toBe("0");
    });
  });

  it("a lot receipt re-averages the lot and rolls item_stock to the batch sum (0078)", async () => {
    await withClient(async (client) => {
      await createDoc(client, {
        kind: "receipt",
        lines: [{ itemId: item.batchId, quantity: "10", unitCost: 100, lot: "LOT-R" }],
      });
      // Top the same lot up at a different cost: 10@100 + 5@130 → 15@110.
      await createDoc(client, {
        kind: "receipt",
        lines: [{ itemId: item.batchId, quantity: "5", unitCost: 130, lot: "LOT-R" }],
      });

      const ledger = await batchLedger(client, item.batchId);
      expect(ledger.batch_qty).toBe("15");
      expect(ledger.stock_qty).toBe("15");
      // The rollup cost is the weighted average across the (single) batch.
      expect(ledger.batch_cost).toBe("1650"); // 15 × 110
      expect(ledger.stock_cost).toBe("110");

      // The GL posted each document at its own stated value: 1000 + 650.
      const bal = await glBalances(client);
      expect(bal.inventory_gl).toBe("1650");
      expect(bal.other_income_gl).toBe("-1650");
    });
  });

  it("repeated lot upserts keep summing quantity and re-averaging cost", async () => {
    await withClient(async (client) => {
      for (const [qty, cost] of [
        ["10", 100],
        ["10", 100],
        ["10", 130],
      ] as const) {
        await createDoc(client, {
          kind: "receipt",
          lines: [{ itemId: item.batchId, quantity: qty, unitCost: cost, lot: "LOT-U" }],
        });
      }
      // 30 units, (10×100 + 10×100 + 10×130) / 30 = 110.
      const ledger = await batchLedger(client, item.batchId);
      expect(ledger.batch_qty).toBe("30");
      expect(ledger.stock_qty).toBe("30");
      expect(ledger.stock_cost).toBe("110");
      expect(ledger.batch_cost).toBe("3300"); // 30 × 110

      // Still exactly one lot row — the upsert never forked the batch.
      const { rows: lots } = await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM item_batches WHERE item_id = $1",
        [item.batchId],
      );
      expect(lots[0].n).toBe("1");
    });
  });

  it("an issue relieves the named lot at its own cost and posts Debit 5900 / Credit 1350", async () => {
    await withClient(async (client) => {
      await createDoc(client, {
        kind: "receipt",
        lines: [{ itemId: item.batchId, quantity: "10", unitCost: 100, lot: "LOT-I" }],
      });
      const issued = await createDoc(client, {
        kind: "issue",
        lines: [{ itemId: item.batchId, quantity: "4", lot: "LOT-I" }],
      });
      expect(issued.debitCode).toBe("5900");
      expect(issued.creditCode).toBe("1350");
      // 4 × the lot's own 100 — not any other cost basis.
      expect(issued.totalValue).toBe("400");

      const ledger = await batchLedger(client, item.batchId);
      expect(ledger.batch_qty).toBe("6");
      expect(ledger.stock_qty).toBe("6");
      expect(ledger.stock_cost).toBe("100");

      // Receipt 1000 in, issue 400 out.
      const bal = await glBalances(client);
      expect(bal.inventory_gl).toBe("600");
      expect(bal.other_income_gl).toBe("-1000");
      expect(bal.other_expense_gl).toBe("400");

      // The document line records the lot and the relieved cost.
      const { rows: lines } = await client.query<{ lot_number: string | null; unit_cost: string; value_rial: string }>(
        `SELECT l.lot_number, l.unit_cost::text, l.value_rial::text
           FROM retail_warehouse_document_lines l
           JOIN retail_warehouse_documents d ON d.id = l.document_id
          WHERE d.kind = 'issue' AND l.item_id = $1`,
        [item.batchId],
      );
      expect(lines[0].lot_number).toBe("LOT-I");
      expect(lines[0].unit_cost).toBe("100");
      expect(lines[0].value_rial).toBe("400");
    });
  });

  it("refuses short stock on a plain item (no negative layers in retail)", async () => {
    await withClient(async (client) => {
      await createDoc(client, {
        kind: "receipt",
        lines: [{ itemId: item.plainId, quantity: "5", unitCost: 1000 }],
      });
      // A covered issue of the plain item works and relieves at running cost.
      const issued = await createDoc(client, {
        kind: "issue",
        lines: [{ itemId: item.plainId, quantity: "2" }],
      });
      expect(issued.totalValue).toBe("2000");

      // Then the stock runs short — refused, never a negative layer.
      await expect(
        createDoc(client, { kind: "issue", lines: [{ itemId: item.plainId, quantity: "5" }] }),
      ).rejects.toThrow(/موجودی کافی نیست/);

      const { rows: stockRows } = await client.query<{ quantity: string }>(
        "SELECT trim_scale(quantity)::text AS quantity FROM item_stock WHERE item_id = $1",
        [item.plainId],
      );
      expect(stockRows[0].quantity).toBe("3");
    });
  });

  it("refuses an issue without a lot, and with a lot that does not exist", async () => {
    await withClient(async (client) => {
      await createDoc(client, {
        kind: "receipt",
        lines: [{ itemId: item.batchId, quantity: "5", unitCost: 100, lot: "LOT-M" }],
      });
      await expect(
        createDoc(client, { kind: "issue", lines: [{ itemId: item.batchId, quantity: "1" }] }),
      ).rejects.toThrow(/بچ را مشخص کنید/);
      await expect(
        createDoc(client, { kind: "issue", lines: [{ itemId: item.batchId, quantity: "1", lot: "NO-SUCH-LOT" }] }),
      ).rejects.toThrow(/بچ یافت نشد/);
    });
  });

  it("refuses an issue beyond the lot's own quantity", async () => {
    await withClient(async (client) => {
      await createDoc(client, {
        kind: "receipt",
        lines: [{ itemId: item.batchId, quantity: "5", unitCost: 100, lot: "LOT-O1" }],
      });
      await createDoc(client, {
        kind: "receipt",
        lines: [{ itemId: item.batchId, quantity: "5", unitCost: 200, lot: "LOT-O2" }],
      });
      // The item holds 10, but this lot only holds 5 — over-lot is refused
      // even though the item as a whole could cover it.
      await expect(
        createDoc(client, { kind: "issue", lines: [{ itemId: item.batchId, quantity: "6", lot: "LOT-O1" }] }),
      ).rejects.toThrow(/بچ کافی نیست/);
    });
  });

  it("refuses serial-tracked items in warehouse documents", async () => {
    await withClient(async (client) => {
      await expect(
        createDoc(client, { kind: "receipt", lines: [{ itemId: item.serialId, quantity: "1", unitCost: 1_000_000 }] }),
      ).rejects.toThrow(/سریالی/);
      await expect(
        createDoc(client, { kind: "issue", lines: [{ itemId: item.serialId, quantity: "1" }] }),
      ).rejects.toThrow(/سریالی/);
    });
  });

  it("refuses weight-tracked items in warehouse documents", async () => {
    await withClient(async (client) => {
      await expect(
        createDoc(client, { kind: "receipt", lines: [{ itemId: item.weightId, quantity: "1", unitCost: 50_000_000 }] }),
      ).rejects.toThrow(/وزنی/);
    });
  });

  it("refuses a supplier on a receipt — that is what خرید and حواله بازگشت are", async () => {
    await withClient(async (client) => {
      await expect(
        createDoc(client, {
          kind: "receipt",
          supplierId: randomUUID(),
          lines: [{ itemId: item.plainId, quantity: "1", unitCost: 1000 }],
        }),
      ).rejects.toThrow(/تأمین‌کننده/);
    });
  });

  it("refuses another tenant's warehouse and a foreign branch's item; expiry is created then preserved", async () => {
    await withClient(async (client) => {
      // Tenant isolation: the other business's location under this business id.
      await expect(
        createDoc(client, {
          kind: "receipt",
          locationId: biz.otherBizLocationId,
          lines: [{ itemId: item.plainId, quantity: "1", unitCost: 1000 }],
        }),
      ).rejects.toThrow(/انبار یافت نشد/);

      // Foreign branch: this business's other-branch item in this branch's document.
      await expect(
        createDoc(client, {
          kind: "receipt",
          lines: [{ itemId: item.otherBranchPlainId, quantity: "1", unitCost: 1000 }],
        }),
      ).rejects.toThrow(/کالا در این انبار یافت نشد/);

      // Expiry: created with the first receipt of a lot…
      await createDoc(client, {
        kind: "receipt",
        lines: [{ itemId: item.batchId, quantity: "2", unitCost: 100, lot: "LOT-E", expiryDate: "2027-06-30" }],
      });
      // …preserved when a top-up carries none…
      await createDoc(client, {
        kind: "receipt",
        lines: [{ itemId: item.batchId, quantity: "2", unitCost: 120, lot: "LOT-E" }],
      });
      // …and replaced when a top-up dates it anew.
      await createDoc(client, {
        kind: "receipt",
        lines: [{ itemId: item.batchId, quantity: "2", unitCost: 140, lot: "LOT-E", expiryDate: "2028-01-01" }],
      });
      const { rows: batch } = await client.query<{ expiry_date: string | null; quantity: string }>(
        "SELECT expiry_date::text, trim_scale(quantity)::text AS quantity FROM item_batches WHERE item_id = $1 AND batch_number = 'LOT-E'",
        [item.batchId],
      );
      expect(batch[0].expiry_date).toBe("2028-01-01");
      expect(batch[0].quantity).toBe("6");
    });
  });
});
