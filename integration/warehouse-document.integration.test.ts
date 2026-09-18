import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import {
  createWarehouseDocumentInTransaction,
  parseWarehouseDocumentLines,
  type WarehouseDocumentLine,
} from "../src/lib/warehouse-document-service";
import { WELL_KNOWN_CODES } from "../src/lib/coa-template";
import { positiveQuantityText, rialText } from "../src/lib/inventory-exact";
// Registers the "inventory.operational_posting" rule the service posts through.
import "../src/lib/fnb-posting-rules";

const configuredUrl = process.env.DATABASE_URL;
if (!configuredUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName = "";
let databaseUrl = "";

function urlFor(database: string): string {
  const url = new URL(configuredUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

async function connect(url = databaseUrl): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

interface Fixture {
  business_id: string;
  location_id: string;
  inventory_item_id: string;
  other_item_id: string;
  other_location_id: string;
}

/** One business, two locations, two items (FIFO), the accounts these documents post to. */
async function seed(client: Client): Promise<Fixture> {
  const { rows } = await client.query<Fixture>(
    `WITH business AS (
       INSERT INTO businesses(name) VALUES('Warehouse Doc Test') RETURNING id
     ), location AS (
       INSERT INTO locations(business_id,name) SELECT id,'Anbar-e Omid' FROM business RETURNING id, business_id
     ), other_location AS (
       INSERT INTO locations(business_id,name) SELECT id,'Anbar-e Dovvom' FROM business RETURNING id
     ), costing AS (
       INSERT INTO settings(business_id,key,value)
       SELECT business_id,'inventory.costing','{"method":"fifo"}'::jsonb FROM location
     ), accounts_created AS (
       INSERT INTO accounts(business_id,code,name,type)
       SELECT business_id,code,name,type::account_type FROM location CROSS JOIN (VALUES
         ('1300','Inventory','asset'),('4900','Other income','revenue'),('5900','Other expense','expense')
       ) a(code,name,type)
     ), item AS (
       INSERT INTO inventory_items(location_id,name,unit,avg_cost,carrying_value_rial)
       SELECT id,'Coffee beans','unit',100,0 FROM location RETURNING id
     ), other_item AS (
       INSERT INTO inventory_items(location_id,name,unit,avg_cost,carrying_value_rial)
       SELECT id,'Tea','unit',50,0 FROM location RETURNING id
     )
     SELECT location.business_id, location.id location_id, item.id inventory_item_id,
            other_item.id other_item_id, other_location.id other_location_id
     FROM location,item,other_item,other_location`,
  );
  return rows[0];
}

/** Seeds a posted receipt the same way the API does, and returns its id. */
async function createReceipt(
  client: Client,
  fixture: Fixture,
  lines: Array<{ item: string; quantity: string; unitCost: string }>,
  opts: { locationId?: string } = {},
): Promise<string> {
  const parsed = parseWarehouseDocumentLines(
    "receipt",
    lines.map((l) => ({
      inventoryItemId: l.item,
      quantity: l.quantity,
      unitCost: l.unitCost,
    })),
  );
  const created = await createWarehouseDocumentInTransaction(client as never, {
    businessId: fixture.business_id,
    locationId: opts.locationId ?? fixture.location_id,
    kind: "receipt",
    supplierId: null,
    recipient: null,
    documentNumber: null,
    note: null,
    createdBy: null,
    lines: parsed.lines,
  });
  return created.id;
}

/** Seeds a posted issue the same way the API does, and returns { id, total }. */
async function createIssue(
  client: Client,
  fixture: Fixture,
  lines: Array<{ item: string; quantity: string }>,
  opts: { locationId?: string; supplierId?: string | null } = {},
): Promise<{ id: string; total: string }> {
  const parsed = parseWarehouseDocumentLines(
    "issue",
    lines.map((l) => ({ inventoryItemId: l.item, quantity: l.quantity })),
  );
  const created = await createWarehouseDocumentInTransaction(client as never, {
    businessId: fixture.business_id,
    locationId: opts.locationId ?? fixture.location_id,
    kind: "issue",
    supplierId: opts.supplierId ?? null,
    recipient: "Anbar-e Omid",
    documentNumber: null,
    note: null,
    createdBy: null,
    lines: parsed.lines,
  });
  return { id: created.id, total: created.totalValue };
}

async function balances(client: Client, fixture: Fixture) {
  const { rows } = await client.query(
    `SELECT
       (SELECT trim_scale(COALESCE(sum(quantity),0))::text FROM stock_movements
         WHERE inventory_item_id=$1 AND location_id=$2) physical,
       (SELECT trim_scale(COALESCE(sum(remaining_quantity),0))::text FROM inventory_negative_layers
         WHERE inventory_item_id=$1) open_negative,
       (SELECT COALESCE(sum(jl.debit-jl.credit),0)::text FROM journal_lines jl
         JOIN accounts a ON a.id=jl.account_id WHERE a.business_id=$3 AND a.code='1300') inventory_gl,
       (SELECT COALESCE(sum(jl.debit-jl.credit),0)::text FROM journal_lines jl
         JOIN accounts a ON a.id=jl.account_id WHERE a.business_id=$3 AND a.code='4900') other_income_gl,
       (SELECT COALESCE(sum(jl.debit-jl.credit),0)::text FROM journal_lines jl
         JOIN accounts a ON a.id=jl.account_id WHERE a.business_id=$3 AND a.code='5900') other_expense_gl`,
    [fixture.inventory_item_id, fixture.location_id, fixture.business_id],
  );
  return rows[0];
}

beforeAll(async () => {
  databaseName = `pos_whdoc_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = await connect(urlFor("postgres"));
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  await admin.end();
  databaseUrl = urlFor(databaseName);
  await runMigrations({ databaseUrl, quiet: true });
});

afterAll(async () => {
  const admin = await connect(urlFor("postgres"));
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.end();
});

describe("warehouse documents (رسید/حواله انبار)", () => {
  it("refuses a service-level empty document before creating shell rows", async () => {
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client);

    await expect(
      createWarehouseDocumentInTransaction(client as never, {
        businessId: fixture.business_id,
        locationId: fixture.location_id,
        kind: "receipt",
        supplierId: null,
        recipient: null,
        documentNumber: null,
        note: null,
        createdBy: null,
        lines: [],
      }),
    ).rejects.toThrow("no_items");

    const { rows: docs } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM warehouse_documents WHERE business_id = $1",
      [fixture.business_id],
    );
    expect(docs[0].n).toBe(0);
    const { rows: events } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM inventory_events WHERE business_id = $1",
      [fixture.business_id],
    );
    expect(events[0].n).toBe(0);

    await client.query("ROLLBACK");
    await client.end();
  });

  it("posts a receipt: stock in, a FIFO lot per line, and Debit inventory / Credit other income", async () => {
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client);
    const docId = await createReceipt(client, fixture, [
      { item: fixture.inventory_item_id, quantity: "2", unitCost: "150" },
      { item: fixture.other_item_id, quantity: "1.5", unitCost: "100" },
    ]);

    // Document rows: authoritative total = 2×150 + 1.5×100 = 450.
    const { rows: docs } = await client.query<{ total_value_rial: string; kind: string }>(
      "SELECT total_value_rial::text, kind FROM warehouse_documents WHERE id = $1",
      [docId],
    );
    expect(docs[0].kind).toBe("receipt");
    expect(docs[0].total_value_rial).toBe("450");

    // The operational event is posted (the event is its own source, as in waste).
    const { rows: events } = await client.query<{ posting: string }>(
      "SELECT posting_status::text AS posting FROM inventory_events WHERE event_type = 'warehouse_receipt'",
    );
    expect(events).toHaveLength(1);
    expect(events[0].posting).toBe("posted");

    // Stock: +2 and +1.5 in, as 'warehouse_in' movements.
    const { rows: movements } = await client.query<{ total: string; type: string; item: string }>(
      `SELECT trim_scale(sum(quantity))::text AS total, type::text AS type, inventory_item_id::text AS item
         FROM stock_movements WHERE location_id = $1 GROUP BY inventory_item_id, type`,
      [fixture.location_id],
    );
    expect(movements).toHaveLength(2);
    expect(movements.every((m) => m.type === "warehouse_in")).toBe(true);
    expect(movements.find((m) => m.item === fixture.inventory_item_id)?.total).toBe("2");
    expect(movements.find((m) => m.item === fixture.other_item_id)?.total).toBe("1.5");

    // One lot per line, values preserved.
    const { rows: lots } = await client.query<{ item: string; remaining_qty: string; remaining_value_rial: string }>(
      `SELECT inventory_item_id::text AS item, trim_scale(remaining_qty)::text AS remaining_qty,
              remaining_value_rial::text AS remaining_value_rial
         FROM inventory_lots WHERE location_id = $1`,
      [fixture.location_id],
    );
    expect(lots).toHaveLength(2);
    const coffeeLot = lots.find((l) => l.item === fixture.inventory_item_id);
    const teaLot = lots.find((l) => l.item === fixture.other_item_id);
    expect(coffeeLot?.remaining_qty).toBe("2");
    expect(coffeeLot?.remaining_value_rial).toBe("300");
    expect(teaLot?.remaining_qty).toBe("1.5");
    expect(teaLot?.remaining_value_rial).toBe("150");

    // Ledger: inventory +450; other income is a credit balance, hence -450 as debit−credit.
    const bal = await balances(client, fixture);
    expect(bal.inventory_gl).toBe("450");
    expect(bal.other_income_gl).toBe("-450");
    expect(bal.other_expense_gl).toBe("0");

    await client.query("ROLLBACK");
    await client.end();
  });

  it("a receipt settles an open negative layer before creating a lot", async () => {
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client);

    // Open a priced shortage of 2 units at the item's 100 Rial cost.
    const shortage = await createIssue(client, fixture, [{ item: fixture.inventory_item_id, quantity: "2" }]);
    expect(shortage.total).toBe("200");

    // A physical receipt of 2 units covers the shortage exactly — no positive lot remains.
    const docId = await createReceipt(client, fixture, [
      { item: fixture.inventory_item_id, quantity: "2", unitCost: "150" },
    ]);

    const { rows: negative } = await client.query<{ remaining: string }>(
      "SELECT trim_scale(sum(remaining_quantity))::text AS remaining FROM inventory_negative_layers WHERE inventory_item_id = $1",
      [fixture.inventory_item_id],
    );
    expect(negative[0].remaining).toBe("0");

    const { rows: lots } = await client.query(
      "SELECT count(*)::int AS n FROM inventory_lots WHERE inventory_item_id = $1",
      [fixture.inventory_item_id],
    );
    expect(lots[0].n).toBe(0);

    const { rows: settlements } = await client.query<{ n: number; actual: string }>(
      `SELECT count(*)::int AS n, COALESCE(sum(actual_value_rial),0)::text AS actual
         FROM inventory_negative_layer_settlements WHERE warehouse_document_id = $1`,
      [docId],
    );
    expect(settlements[0].n).toBe(1);
    expect(settlements[0].actual).toBe("300");

    // Net stock back to zero; the receipt still posted its full value.
    // other income is a credit balance, hence -300 as debit−credit.
    const bal = await balances(client, fixture);
    expect(bal.physical).toBe("0");
    expect(bal.inventory_gl).toBe("100"); // -200 (issue) + 300 (receipt)
    expect(bal.other_income_gl).toBe("-300");
    expect(bal.other_expense_gl).toBe("200");

    await client.query("ROLLBACK");
    await client.end();
  });

  it("posts an issue from on-hand stock at the exact lot cost", async () => {
    const client = await connect();
    // Two separate transactions so the two lots get distinct received_at
    // stamps and FIFO order is deterministic.
    await client.query("BEGIN");
    const fixture = await seed(client);
    await createReceipt(client, fixture, [
      { item: fixture.inventory_item_id, quantity: "2", unitCost: "200" },
    ]);
    await client.query("COMMIT");

    await client.query("BEGIN");
    await createReceipt(client, fixture, [
      { item: fixture.inventory_item_id, quantity: "3", unitCost: "100" },
    ]);

    // FIFO consumes the 200-Rial lot first: 2×200 + 0.5×100 = 450.
    const created = await createIssue(client, fixture, [
      { item: fixture.inventory_item_id, quantity: "2.5" },
    ]);
    expect(created.total).toBe("450");

    const { rows: docs } = await client.query<{ total: string; kind: string }>(
      `SELECT total_value_rial::text AS total, kind FROM warehouse_documents WHERE id = $1`,
      [created.id],
    );
    expect(docs[0].kind).toBe("issue");
    expect(docs[0].total).toBe("450");

    // One movement per lot consumed (the consumption path's established shape).
    const { rows: movements } = await client.query<{ total: string; n: number }>(
      `SELECT trim_scale(sum(quantity))::text AS total, count(*)::int AS n
         FROM stock_movements WHERE inventory_item_id = $1 AND type = 'warehouse_out'`,
      [fixture.inventory_item_id],
    );
    expect(movements[0].n).toBe(2);
    expect(movements[0].total).toBe("-2.5");

    const bal = await balances(client, fixture);
    expect(bal.physical).toBe("2.5");
    expect(bal.other_expense_gl).toBe("450");
    // Inventory net: +700 (receipt) - 450 (issue).
    expect(bal.inventory_gl).toBe("250");

    await client.query("ROLLBACK");
    await client.end();
  });

  it("an issue past on-hand stock opens a priced negative layer at the consumed lot's cost", async () => {
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client);
    await createReceipt(client, fixture, [
      { item: fixture.inventory_item_id, quantity: "1", unitCost: "300" },
    ]);

    // Only 1 unit on hand (300 Rial); the extra 1 prices at the last consumed
    // lot's cost (300), not the item's average.
    const created = await createIssue(client, fixture, [
      { item: fixture.inventory_item_id, quantity: "2" },
    ]);
    expect(created.total).toBe("600");

    const { rows: negative } = await client.query<{ qty: string }>(
      "SELECT trim_scale(sum(remaining_quantity))::text AS qty FROM inventory_negative_layers WHERE inventory_item_id = $1",
      [fixture.inventory_item_id],
    );
    expect(negative[0].qty).toBe("1");

    const bal = await balances(client, fixture);
    expect(bal.physical).toBe("-1");
    expect(bal.other_expense_gl).toBe("600");

    await client.query("ROLLBACK");
    await client.end();
  });

  it("refuses an inactive location, a foreign item, and a supplier on an issue", async () => {
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client);

    // Inactive location.
    await client.query("UPDATE locations SET is_active = false WHERE id = $1", [fixture.location_id]);
    let failed: unknown;
    try {
      await createReceipt(client, fixture, [
        { item: fixture.inventory_item_id, quantity: "1", unitCost: "100" },
      ]);
    } catch (err) {
      failed = err;
    }
    expect((failed as Error).message).toBe("location_inactive");
    await client.query("UPDATE locations SET is_active = true WHERE id = $1", [fixture.location_id]);

    // A supplier on an issue is not a field issues carry.
    const { rows: supplier } = await client.query<{ id: string }>(
      "INSERT INTO suppliers(location_id,name) VALUES($1,'Taamineh') RETURNING id",
      [fixture.location_id],
    );
    try {
      await createIssue(client, fixture, [
        { item: fixture.inventory_item_id, quantity: "1" },
      ], { supplierId: supplier[0].id });
      throw new Error("expected the supplier-on-issue to be refused");
    } catch (err) {
      expect((err as Error).message).toBe("invalid_line");
    }

    // An item that belongs to the other location.
    const { rows: otherItem } = await client.query<{ id: string }>(
      "INSERT INTO inventory_items(location_id,name,unit,avg_cost,carrying_value_rial) VALUES($1,'Tea','unit',50,0) RETURNING id",
      [fixture.other_location_id],
    );
    const parsed: { lines: WarehouseDocumentLine[] } = parseWarehouseDocumentLines("receipt", [
      { inventoryItemId: otherItem[0].id, quantity: "1", unitCost: "100" },
    ]);
    try {
      await createWarehouseDocumentInTransaction(client as never, {
        businessId: fixture.business_id,
        locationId: fixture.location_id,
        kind: "receipt",
        supplierId: null,
        recipient: null,
        documentNumber: null,
        note: null,
        createdBy: null,
        lines: parsed.lines,
      });
      throw new Error("expected the foreign item to be refused");
    } catch (err) {
      expect((err as Error).message).toBe("item_not_found");
    }

    // An unknown location of another business.
    const { rows: stranger } = await client.query<{ id: string }>(
      `WITH b AS (INSERT INTO businesses(name) VALUES('Kasbi Dovvom') RETURNING id)
         SELECT id FROM b`,
    );
    try {
      await createReceipt(client, fixture, [
        { item: fixture.inventory_item_id, quantity: "1", unitCost: "100" },
      ], { locationId: stranger[0].id });
      throw new Error("expected the foreign location to be refused");
    } catch (err) {
      expect((err as Error).message).toBe("location_not_found");
    }

    await client.query("ROLLBACK");
    await client.end();
  });
  /* ----------------------------------------------------------------------
   * Regressions: four ways a perfectly ordinary document used to abort the
   * transaction with a raw Postgres error (i.e. a 500) instead of posting or
   * refusing cleanly. Each of these failed on the pre-fix code.
   * ------------------------------------------------------------------- */

  it("posts an issue whose derived unit cost is fractional", async () => {
    // 0.7 of a 333-Rial lot costs 233 Rial → 332.857142857 per unit. That went
    // straight into `warehouse_document_lines.unit_cost`, a BIGINT column, and
    // Postgres rejected the INSERT: «invalid input syntax for type bigint».
    // An everyday fractional حواله simply could not be posted.
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client);
    await createReceipt(client, fixture, [
      { item: fixture.inventory_item_id, quantity: "3", unitCost: "333" },
    ]);

    const issued = await createIssue(client, fixture, [
      { item: fixture.inventory_item_id, quantity: "0.7" },
    ]);

    const { rows } = await client.query<{ quantity: string; unit_cost: string; value_rial: string }>(
      `SELECT trim_scale(quantity)::text quantity, unit_cost::text, value_rial::text
         FROM warehouse_document_lines WHERE document_id=$1`,
      [issued.id],
    );
    expect(rows[0].quantity).toBe("0.7");
    // value_rial is authoritative (it is what the ledger posts); unit_cost is
    // its whole-Rial read-out: 233 / 0.7 = 332.857… → 333.
    expect(rows[0].value_rial).toBe("233");
    expect(rows[0].unit_cost).toBe("333");
    expect(issued.total).toBe("233");

    const after = await balances(client, fixture);
    expect(after.other_expense_gl).toBe("233");
    expect(after.inventory_gl).toBe(String(3 * 333 - 233));

    await client.query("ROLLBACK");
    await client.end();
  });

  it("keeps a sub-milli-unit quantity exactly as the stock ledger records it", async () => {
    // `warehouse_document_lines.quantity` was numeric(14,3) while every other
    // quantity on this path is numeric(24,9) — so a 0.0005 receipt stored
    // 0.001 on the document and 0.000500000 in stock_movements: the document a
    // person reads back was not the quantity the inventory moved. Below half a
    // milli-unit it rounded to 0.000 and tripped the CHECK (quantity > 0).
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client);

    const docId = await createReceipt(client, fixture, [
      { item: fixture.inventory_item_id, quantity: "0.0005", unitCost: "1000000" },
    ]);

    const { rows: line } = await client.query<{ quantity: string; value_rial: string }>(
      `SELECT trim_scale(quantity)::text quantity, value_rial::text
         FROM warehouse_document_lines WHERE document_id=$1`,
      [docId],
    );
    const { rows: movement } = await client.query<{ quantity: string }>(
      `SELECT trim_scale(quantity)::text quantity FROM stock_movements
        WHERE source_id=$1 AND source_type='warehouse_receipt'`,
      [docId],
    );
    expect(line[0].quantity).toBe("0.0005");
    expect(line[0].quantity).toBe(movement[0].quantity);
    expect(line[0].value_rial).toBe("500");

    // And a quantity that used to round away to zero now posts intact.
    const tinyId = await createReceipt(client, fixture, [
      { item: fixture.other_item_id, quantity: "0.0001", unitCost: "10000000" },
    ]);
    const { rows: tiny } = await client.query<{ quantity: string; value_rial: string }>(
      `SELECT trim_scale(quantity)::text quantity, value_rial::text
         FROM warehouse_document_lines WHERE document_id=$1`,
      [tinyId],
    );
    expect(tiny[0].quantity).toBe("0.0001");
    expect(tiny[0].value_rial).toBe("1000");

    await client.query("ROLLBACK");
    await client.end();
  });

  it("refuses a valueless receipt instead of violating the lot's value bounds", async () => {
    // A zero-cost receipt reached `INSERT INTO inventory_lots` and aborted the
    // transaction on `inventory_lot_exact_value_bounds` — 0015 forbids a lot
    // holding quantity at zero value. The refusal now happens at parse time,
    // identically under every costing method, before anything is written.
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client);

    expect(() =>
      parseWarehouseDocumentLines("receipt", [
        { inventoryItemId: fixture.inventory_item_id, quantity: "2", unitCost: "0" },
      ]),
    ).toThrow("receipt_value_required");

    const { rows: docs } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM warehouse_documents WHERE business_id = $1",
      [fixture.business_id],
    );
    expect(docs[0].n).toBe(0);

    await client.query("ROLLBACK");
    await client.end();
  });

  it("answers a non-uuid id as not-found rather than a uuid syntax error", async () => {
    // `WHERE id = $1` against a uuid column raises «invalid input syntax for
    // type uuid» for a non-uuid — a 500 where an honest 404 belongs.
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client);

    const parsed = parseWarehouseDocumentLines("receipt", [
      { inventoryItemId: "unknown", quantity: "1", unitCost: "100" },
    ]);
    await expect(
      createWarehouseDocumentInTransaction(client as never, {
        businessId: fixture.business_id,
        locationId: fixture.location_id,
        kind: "receipt",
        supplierId: null,
        recipient: null,
        documentNumber: null,
        note: null,
        createdBy: null,
        lines: parsed.lines,
      }),
    ).rejects.toThrow("item_not_found");

    const good = parseWarehouseDocumentLines("receipt", [
      { inventoryItemId: fixture.inventory_item_id, quantity: "1", unitCost: "100" },
    ]);
    await expect(
      createWarehouseDocumentInTransaction(client as never, {
        businessId: fixture.business_id,
        locationId: "not-a-uuid",
        kind: "receipt",
        supplierId: null,
        recipient: null,
        documentNumber: null,
        note: null,
        createdBy: null,
        lines: good.lines,
      }),
    ).rejects.toThrow("location_not_found");

    await client.query("ROLLBACK");
    await client.end();
  });
});
