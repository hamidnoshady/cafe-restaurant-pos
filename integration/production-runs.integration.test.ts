/**
 * Phase 29 — in-house production, end to end against a real database.
 *
 * The scenario throughout is the one the feature was built for: a café bakes
 * cakes from raw materials, a batch yields a number of slices, and each slice
 * is then sold through an ordinary serving recipe. What must hold is that the
 * produced good behaves as an ordinary inventory item in every direction —
 * it takes stock, it takes a cost, it costs out through the same consumption
 * path a sale uses, and the whole transformation nets correctly in the ledger.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { consumeInventoryExact } from "../src/lib/inventory-consumption-exact";
import { positiveQuantityText, rialText } from "../src/lib/inventory-exact";
import { recordProductionRun, reverseProductionRun } from "../src/lib/production-service";

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
  businessId: string;
  locationId: string;
  flourId: string;
  sugarId: string;
  sliceId: string;
  formulaId: string;
}

/**
 * A business with two raw materials in stock at known costs, a produced item
 * with none, and a formula: one batch = 500g flour + 300g sugar → 8 slices,
 * with 200,000 rial of labour.
 *
 * Opening stock is written straight into the lots rather than through a
 * purchase, so the arithmetic every assertion below rests on is visible here
 * rather than derived: flour is 1,000 rial/g and sugar 500 rial/g.
 */
async function seed(client: Client, method: "fifo" | "weighted_average" = "fifo"): Promise<Fixture> {
  const { rows } = await client.query<{
    business_id: string;
    location_id: string;
    flour_id: string;
    sugar_id: string;
    slice_id: string;
  }>(
    `WITH business AS (
       INSERT INTO businesses(name) VALUES('Production Test') RETURNING id
     ), location AS (
       INSERT INTO locations(business_id,name) SELECT id,'Main' FROM business RETURNING id,business_id
     ), costing AS (
       INSERT INTO settings(business_id,key,value)
       SELECT business_id,'inventory.costing',$1::jsonb FROM location
     ), accounts_created AS (
       INSERT INTO accounts(business_id,code,name,type)
       SELECT business_id,code,name,type::account_type FROM location CROSS JOIN (VALUES
         ('1300','Inventory','asset'),('1310','WIP','asset'),
         ('5100','COGS','expense'),('5180','Applied conversion','expense')
       ) a(code,name,type)
     ), flour AS (
       INSERT INTO inventory_items(location_id,name,unit,avg_cost,carrying_value_rial)
       SELECT id,'آرد','g',1000,2000000 FROM location RETURNING id
     ), sugar AS (
       INSERT INTO inventory_items(location_id,name,unit,avg_cost,carrying_value_rial)
       SELECT id,'شکر','g',500,500000 FROM location RETURNING id
     ), slice AS (
       INSERT INTO inventory_items(location_id,name,unit,avg_cost,carrying_value_rial,is_produced)
       SELECT id,'کیک شکلاتی (برش)','برش',0,0,true FROM location RETURNING id
     )
     SELECT location.business_id, location.id location_id,
            flour.id flour_id, sugar.id sugar_id, slice.id slice_id
     FROM location, flour, sugar, slice`,
    [JSON.stringify({ method })],
  );
  const row = rows[0];

  for (const [itemId, quantity, value] of [
    [row.flour_id, "2000", "2000000"],
    [row.sugar_id, "1000", "500000"],
  ] as const) {
    await client.query(
      `INSERT INTO stock_movements(location_id,inventory_item_id,type,quantity,unit_cost,cost_value_rial,source_type)
       VALUES($1,$2,'purchase',$3::numeric,$4::numeric/$3::numeric,$4,'opening')`,
      [row.location_id, itemId, quantity, value],
    );
    await client.query(
      `INSERT INTO inventory_lots(location_id,inventory_item_id,remaining_qty,unit_cost,source_type,
                                  original_quantity,original_value_rial,remaining_value_rial)
       VALUES($1,$2,$3::numeric,$4::numeric/$3::numeric,'opening',$3::numeric,$4,$4)`,
      [row.location_id, itemId, quantity, value],
    );
  }

  const formulaId = randomUUID();
  await client.query(
    `INSERT INTO production_formulas
       (id,business_id,location_id,name,output_inventory_item_id,output_quantity,conversion_cost_rial)
     VALUES($1,$2,$3,'تولید کیک شکلاتی',$4,8,200000)`,
    [formulaId, row.business_id, row.location_id, row.slice_id],
  );
  await client.query(
    `INSERT INTO production_formula_inputs(formula_id,inventory_item_id,quantity)
     VALUES($1,$2,500),($1,$3,300)`,
    [formulaId, row.flour_id, row.sugar_id],
  );

  return {
    businessId: row.business_id,
    locationId: row.location_id,
    flourId: row.flour_id,
    sugarId: row.sugar_id,
    sliceId: row.slice_id,
    formulaId,
  };
}

async function stockOf(client: Client, inventoryItemId: string): Promise<string> {
  const { rows } = await client.query<{ quantity: string }>(
    "SELECT trim_scale(COALESCE(sum(quantity),0))::text quantity FROM stock_movements WHERE inventory_item_id=$1",
    [inventoryItemId],
  );
  return rows[0].quantity;
}

async function accountBalance(client: Client, businessId: string, code: string): Promise<string> {
  const { rows } = await client.query<{ balance: string }>(
    `SELECT COALESCE(sum(jl.debit-jl.credit),0)::text balance
       FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id
      WHERE a.business_id=$1 AND a.code=$2`,
    [businessId, code],
  );
  return rows[0].balance;
}

beforeAll(async () => {
  databaseName = `pos_production_${randomUUID().replaceAll("-", "")}`;
  const admin = await connect(urlFor("postgres"));
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  await admin.end();
  databaseUrl = urlFor(databaseName);
  await runMigrations({ databaseUrl, quiet: true });
}, 120_000);

afterAll(async () => {
  const admin = await connect(urlFor("postgres"));
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.end();
});

describe("recording a production run", () => {
  it("consumes the scaled inputs and receipts the output at their exact cost plus conversion", async () => {
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client);

    // Two batches, but the tray came out as 15 slices rather than 16.
    const run = await recordProductionRun(client as never, {
      businessId: fixture.businessId,
      locationId: fixture.locationId,
      formulaId: fixture.formulaId,
      batches: positiveQuantityText("2"),
      outputQuantity: positiveQuantityText("15"),
      conversionCostRial: rialText("400000"),
      note: null,
      createdBy: null,
    });

    // 1000g flour @1000 + 600g sugar @500 = 1,000,000 + 300,000
    expect(run.materialCostRial).toBe("1300000");
    expect(run.totalCostRial).toBe("1700000");
    // Spread over the ACTUAL 15, not the formula's 16.
    expect(run.unitCostRial).toBe("113333.333333333");

    expect(await stockOf(client, fixture.flourId)).toBe("1000");
    expect(await stockOf(client, fixture.sugarId)).toBe("400");
    expect(await stockOf(client, fixture.sliceId)).toBe("15");

    const { rows: lots } = await client.query<{ remaining_qty: string; remaining_value_rial: string }>(
      `SELECT trim_scale(remaining_qty)::text remaining_qty, remaining_value_rial::text
         FROM inventory_lots WHERE inventory_item_id=$1`,
      [fixture.sliceId],
    );
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ remaining_qty: "15", remaining_value_rial: "1700000" });

    const { rows: inputs } = await client.query<{ quantity: string; cost_rial: string }>(
      // Ordered by the table's own column, not the text-cast output column of
      // the same name — ORDER BY resolves output names first, and would sort
      // "300000" above "1000000" as text.
      `SELECT trim_scale(quantity)::text quantity, cost_rial::text
         FROM production_run_inputs WHERE production_run_id=$1
        ORDER BY production_run_inputs.cost_rial DESC`,
      [run.id],
    );
    expect(inputs).toEqual([
      { quantity: "1000", cost_rial: "1000000" },
      { quantity: "600", cost_rial: "300000" },
    ]);

    await client.query("ROLLBACK");
    await client.end();
  });

  it("nets WIP to zero and lifts inventory by exactly the conversion cost", async () => {
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client);

    await recordProductionRun(client as never, {
      businessId: fixture.businessId,
      locationId: fixture.locationId,
      formulaId: fixture.formulaId,
      batches: positiveQuantityText("2"),
      outputQuantity: positiveQuantityText("15"),
      conversionCostRial: rialText("400000"),
      note: null,
      createdBy: null,
    });

    // Materials 1,300,000 left inventory and 1,700,000 of finished goods came
    // back in, so the account is up by the conversion cost and nothing else.
    expect(await accountBalance(client, fixture.businessId, "1300")).toBe("400000");
    // The wash account must not carry a balance between the two.
    expect(await accountBalance(client, fixture.businessId, "1310")).toBe("0");
    // Contra-expense: credited, so it nets against the wages already booked.
    expect(await accountBalance(client, fixture.businessId, "5180")).toBe("-400000");
    // Nothing has been sold, so nothing has reached cost of sales.
    expect(await accountBalance(client, fixture.businessId, "5100")).toBe("0");

    const { rows: entries } = await client.query<{ posting_kind: string }>(
      `SELECT posting_kind FROM journal_entries
        WHERE business_id=$1 AND source_type='production' ORDER BY posting_kind`,
      [fixture.businessId],
    );
    expect(entries.map((e) => e.posting_kind)).toEqual([
      "production_conversion",
      "production_materials",
      "production_output",
    ]);

    await client.query("ROLLBACK");
    await client.end();
  });

  it("posts no conversion entry when the run absorbed nothing", async () => {
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client);

    await recordProductionRun(client as never, {
      businessId: fixture.businessId,
      locationId: fixture.locationId,
      formulaId: fixture.formulaId,
      batches: positiveQuantityText("1"),
      outputQuantity: null,
      conversionCostRial: rialText("0"),
      note: null,
      createdBy: null,
    });

    const { rows: entries } = await client.query<{ posting_kind: string }>(
      `SELECT posting_kind FROM journal_entries
        WHERE business_id=$1 AND source_type='production' ORDER BY posting_kind`,
      [fixture.businessId],
    );
    expect(entries.map((e) => e.posting_kind)).toEqual(["production_materials", "production_output"]);
    // Materials in, same value out: the run moved no value at all.
    expect(await accountBalance(client, fixture.businessId, "1300")).toBe("0");

    await client.query("ROLLBACK");
    await client.end();
  });

  it("defaults the yield and the conversion cost from the formula", async () => {
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client);

    const run = await recordProductionRun(client as never, {
      businessId: fixture.businessId,
      locationId: fixture.locationId,
      formulaId: fixture.formulaId,
      batches: positiveQuantityText("2"),
      outputQuantity: null,
      conversionCostRial: null,
      note: null,
      createdBy: null,
    });

    // 8 slices × 2 batches, 200,000 labour × 2 batches.
    expect(await stockOf(client, fixture.sliceId)).toBe("16");
    expect(run.conversionCostRial).toBe("400000");
    expect(run.totalCostRial).toBe("1700000");

    await client.query("ROLLBACK");
    await client.end();
  });
});

describe("selling what was produced", () => {
  it("costs a slice out through the same consumption path an order uses", async () => {
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client);

    await recordProductionRun(client as never, {
      businessId: fixture.businessId,
      locationId: fixture.locationId,
      formulaId: fixture.formulaId,
      batches: positiveQuantityText("2"),
      outputQuantity: positiveQuantityText("16"),
      conversionCostRial: rialText("400000"),
      note: null,
      createdBy: null,
    });

    // This is exactly what deductForOrder calls for each line of a paid order;
    // the produced item needs no special case there, which is the whole point
    // of it being an ordinary inventory item.
    const { rows: events } = await client.query<{ id: string }>(
      `INSERT INTO inventory_events(business_id,location_id,event_type,source_type,costing_version)
       VALUES($1,$2,'sale_consumption','order',2) RETURNING id`,
      [fixture.businessId, fixture.locationId],
    );
    const saleEvent = events[0].id;
    await client.query("UPDATE inventory_events SET source_id=id WHERE id=$1", [saleEvent]);

    const sale = await consumeInventoryExact(client as never, {
      locationId: fixture.locationId,
      businessId: fixture.businessId,
      inventoryItemId: fixture.sliceId,
      quantity: positiveQuantityText("1"),
      type: "sale",
      sourceType: "order",
      sourceId: saleEvent,
      createdBy: null,
      inventoryEventId: saleEvent,
    });

    // 1,700,000 ÷ 16 slices — the labour that went into the cake is in there.
    expect(sale.postedCost).toBe("106250");
    expect(sale.shortageQuantity).toBe("0");
    expect(await stockOf(client, fixture.sliceId)).toBe("15");

    await client.query("ROLLBACK");
    await client.end();
  });

  it("settles a shortage when slices were sold before the cake was baked", async () => {
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client);

    // Three slices sold off a cake still in the oven. The produced item has no
    // cost history yet, so they cost out at zero and open an unpriced layer —
    // which is precisely what the run then has to settle.
    const { rows: orders } = await client.query<{ id: string }>(
      "INSERT INTO orders(location_id,order_number,status) VALUES($1,1,'completed') RETURNING id",
      [fixture.locationId],
    );
    const orderId = orders[0].id;
    const { rows: events } = await client.query<{ id: string }>(
      `INSERT INTO inventory_events(business_id,location_id,event_type,source_type,source_id,costing_version)
       VALUES($1,$2,'sale_consumption','order',$3,2) RETURNING id`,
      [fixture.businessId, fixture.locationId, orderId],
    );
    const saleEvent = events[0].id;
    const sale = await consumeInventoryExact(client as never, {
      locationId: fixture.locationId,
      businessId: fixture.businessId,
      inventoryItemId: fixture.sliceId,
      quantity: positiveQuantityText("3"),
      type: "sale",
      sourceType: "order",
      sourceId: orderId,
      createdBy: null,
      inventoryEventId: saleEvent,
    });
    expect(sale.shortageQuantity).toBe("3");

    await recordProductionRun(client as never, {
      businessId: fixture.businessId,
      locationId: fixture.locationId,
      formulaId: fixture.formulaId,
      batches: positiveQuantityText("1"),
      outputQuantity: positiveQuantityText("8"),
      conversionCostRial: rialText("200000"),
      note: null,
      createdBy: null,
    });

    // 500g flour @1,000 + 300g sugar @500 = 650,000 of materials, + 200,000 of
    // labour = 850,000 over 8 slices. Three of them go to closing the
    // shortage: 3/8 × 850,000 = 318,750.
    const { rows: layers } = await client.query<{ remaining: string; settled: string | null }>(
      `SELECT trim_scale(remaining_quantity)::text remaining, settled_at::text settled
         FROM inventory_negative_layers WHERE inventory_item_id=$1`,
      [fixture.sliceId],
    );
    expect(layers[0].remaining).toBe("0");
    expect(layers[0].settled).not.toBeNull();

    const { rows: settlements } = await client.query<{
      quantity: string;
      provisional_value_rial: string;
      actual_value_rial: string;
    }>(
      `SELECT trim_scale(quantity)::text quantity, provisional_value_rial::text, actual_value_rial::text
         FROM inventory_negative_layer_settlements WHERE production_run_id IS NOT NULL`,
    );
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      quantity: "3",
      provisional_value_rial: "0",
      actual_value_rial: "318750",
    });

    // Only the residual reached the shelf.
    expect(await stockOf(client, fixture.sliceId)).toBe("5");
    // The sale was booked at zero cost; settling corrects it to what it really
    // cost, which is a debit to COGS.
    expect(await accountBalance(client, fixture.businessId, "5100")).toBe("318750");

    await client.query("ROLLBACK");
    await client.end();
  });
});

describe("reversing a production run", () => {
  it("returns stock and the ledger to exactly where they were", async () => {
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client);

    const run = await recordProductionRun(client as never, {
      businessId: fixture.businessId,
      locationId: fixture.locationId,
      formulaId: fixture.formulaId,
      batches: positiveQuantityText("2"),
      outputQuantity: positiveQuantityText("15"),
      conversionCostRial: rialText("400000"),
      note: null,
      createdBy: null,
    });

    await reverseProductionRun(client as never, {
      businessId: fixture.businessId,
      locationId: fixture.locationId,
      runId: run.id,
      note: "اشتباه ثبت شد",
      createdBy: null,
    });

    expect(await stockOf(client, fixture.flourId)).toBe("2000");
    expect(await stockOf(client, fixture.sugarId)).toBe("1000");
    expect(await stockOf(client, fixture.sliceId)).toBe("0");

    for (const code of ["1300", "1310", "5100", "5180"]) {
      expect(await accountBalance(client, fixture.businessId, code), `account ${code}`).toBe("0");
    }

    // The produced item must be left with no value hanging on it, or the next
    // batch would inherit the reversed one's cost.
    const { rows: sliceLots } = await client.query<{ remaining: string }>(
      `SELECT COALESCE(sum(remaining_value_rial),0)::text remaining
         FROM inventory_lots WHERE inventory_item_id=$1`,
      [fixture.sliceId],
    );
    expect(sliceLots[0].remaining).toBe("0");

    const { rows: statuses } = await client.query<{ event_type: string; posting_status: string }>(
      `SELECT event_type::text, posting_status::text FROM inventory_events
        WHERE business_id=$1 ORDER BY event_type`,
      [fixture.businessId],
    );
    expect(statuses).toEqual([
      { event_type: "production", posting_status: "reversed" },
      { event_type: "production_reversal", posting_status: "posted" },
    ]);

    await client.query("ROLLBACK");
    await client.end();
  });

  it("puts the materials back into their original FIFO position, not behind later stock", async () => {
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client);

    const run = await recordProductionRun(client as never, {
      businessId: fixture.businessId,
      locationId: fixture.locationId,
      formulaId: fixture.formulaId,
      batches: positiveQuantityText("1"),
      outputQuantity: null,
      conversionCostRial: rialText("0"),
      note: null,
      createdBy: null,
    });
    await reverseProductionRun(client as never, {
      businessId: fixture.businessId,
      locationId: fixture.locationId,
      runId: run.id,
      note: null,
      createdBy: null,
    });

    // Flour went back at 1,000 rial/g — the cost it left at — so the item's
    // whole remaining value still divides evenly by its quantity.
    const { rows } = await client.query<{ quantity: string; value: string }>(
      `SELECT trim_scale(COALESCE(sum(remaining_qty),0))::text quantity,
              COALESCE(sum(remaining_value_rial),0)::text value
         FROM inventory_lots WHERE inventory_item_id=$1 AND remaining_qty>0`,
      [fixture.flourId],
    );
    expect(rows[0]).toMatchObject({ quantity: "2000", value: "2000000" });

    await client.query("ROLLBACK");
    await client.end();
  });

  it("refuses once part of the batch has been sold", async () => {
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client);

    const run = await recordProductionRun(client as never, {
      businessId: fixture.businessId,
      locationId: fixture.locationId,
      formulaId: fixture.formulaId,
      batches: positiveQuantityText("1"),
      outputQuantity: null,
      conversionCostRial: rialText("200000"),
      note: null,
      createdBy: null,
    });

    const { rows: events } = await client.query<{ id: string }>(
      `INSERT INTO inventory_events(business_id,location_id,event_type,source_type,costing_version)
       VALUES($1,$2,'sale_consumption','order',2) RETURNING id`,
      [fixture.businessId, fixture.locationId],
    );
    await client.query("UPDATE inventory_events SET source_id=id WHERE id=$1", [events[0].id]);
    await consumeInventoryExact(client as never, {
      locationId: fixture.locationId,
      businessId: fixture.businessId,
      inventoryItemId: fixture.sliceId,
      quantity: positiveQuantityText("1"),
      type: "sale",
      sourceType: "order",
      sourceId: events[0].id,
      createdBy: null,
      inventoryEventId: events[0].id,
    });

    // Unwinding now would mean re-costing a sale that is already posted.
    await expect(
      reverseProductionRun(client as never, {
        businessId: fixture.businessId,
        locationId: fixture.locationId,
        runId: run.id,
        note: null,
        createdBy: null,
      }),
    ).rejects.toThrow("production_output_consumed");

    await client.query("ROLLBACK");
    await client.end();
  });

  it("refuses to reverse the same run twice", async () => {
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client);

    const run = await recordProductionRun(client as never, {
      businessId: fixture.businessId,
      locationId: fixture.locationId,
      formulaId: fixture.formulaId,
      batches: positiveQuantityText("1"),
      outputQuantity: null,
      conversionCostRial: rialText("0"),
      note: null,
      createdBy: null,
    });
    await reverseProductionRun(client as never, {
      businessId: fixture.businessId,
      locationId: fixture.locationId,
      runId: run.id,
      note: null,
      createdBy: null,
    });

    await expect(
      reverseProductionRun(client as never, {
        businessId: fixture.businessId,
        locationId: fixture.locationId,
        runId: run.id,
        note: null,
        createdBy: null,
      }),
    ).rejects.toThrow("already_reversed");

    await client.query("ROLLBACK");
    await client.end();
  });
});

describe("weighted-average costing", () => {
  it("rolls the batch into the produced item's carrying value and average", async () => {
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client, "weighted_average");

    await recordProductionRun(client as never, {
      businessId: fixture.businessId,
      locationId: fixture.locationId,
      formulaId: fixture.formulaId,
      batches: positiveQuantityText("2"),
      outputQuantity: positiveQuantityText("16"),
      conversionCostRial: rialText("400000"),
      note: null,
      createdBy: null,
    });

    const { rows } = await client.query<{ carrying_value_rial: string; avg_cost: string }>(
      "SELECT carrying_value_rial::text, trim_scale(avg_cost)::text avg_cost FROM inventory_items WHERE id=$1",
      [fixture.sliceId],
    );
    expect(rows[0]).toMatchObject({ carrying_value_rial: "1700000", avg_cost: "106250" });

    // The raw materials paid for it out of their own carrying value.
    const { rows: flour } = await client.query<{ carrying_value_rial: string }>(
      "SELECT carrying_value_rial::text FROM inventory_items WHERE id=$1",
      [fixture.flourId],
    );
    expect(flour[0].carrying_value_rial).toBe("1000000");

    await client.query("ROLLBACK");
    await client.end();
  });

  it("reverses cleanly under weighted average too", async () => {
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client, "weighted_average");

    const run = await recordProductionRun(client as never, {
      businessId: fixture.businessId,
      locationId: fixture.locationId,
      formulaId: fixture.formulaId,
      batches: positiveQuantityText("1"),
      outputQuantity: null,
      conversionCostRial: rialText("200000"),
      note: null,
      createdBy: null,
    });
    await reverseProductionRun(client as never, {
      businessId: fixture.businessId,
      locationId: fixture.locationId,
      runId: run.id,
      note: null,
      createdBy: null,
    });

    const { rows } = await client.query<{ slice: string; flour: string; sugar: string }>(
      `SELECT (SELECT carrying_value_rial::text FROM inventory_items WHERE id=$1) slice,
              (SELECT carrying_value_rial::text FROM inventory_items WHERE id=$2) flour,
              (SELECT carrying_value_rial::text FROM inventory_items WHERE id=$3) sugar`,
      [fixture.sliceId, fixture.flourId, fixture.sugarId],
    );
    expect(rows[0]).toEqual({ slice: "0", flour: "2000000", sugar: "500000" });
    expect(await accountBalance(client, fixture.businessId, "1310")).toBe("0");

    await client.query("ROLLBACK");
    await client.end();
  });
});
