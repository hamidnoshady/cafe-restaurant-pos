import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { consumeInventoryExact } from "../src/lib/inventory-consumption-exact";
import { applyStockAdjustmentExact } from "../src/lib/inventory-adjustment-exact";
import { applyPurchaseReceiptCosting } from "../src/lib/purchase-receipt-costing";
import {
  postExactNegativeSettlementEntry,
  postExactOperationalInventoryEntry,
  postExactPurchaseEntry,
  postExactStockCountEntry,
} from "../src/lib/ledger-service";
import { WELL_KNOWN_CODES } from "../src/lib/coa-template";
import { positiveQuantityText, rialText } from "../src/lib/inventory-exact";

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
}

/** One business/location/item, FIFO, with the accounts these paths post to. */
async function seed(client: Client, avgCost: string): Promise<Fixture> {
  const { rows } = await client.query<Fixture>(
    `WITH business AS (
       INSERT INTO businesses(name) VALUES('Exact Ops Test') RETURNING id
     ), location AS (
       INSERT INTO locations(business_id,name) SELECT id,'Main' FROM business RETURNING id,business_id
     ), costing AS (
       INSERT INTO settings(business_id,key,value)
       SELECT business_id,'inventory.costing','{"method":"fifo"}'::jsonb FROM location
     ), accounts_created AS (
       INSERT INTO accounts(business_id,code,name,type)
       SELECT business_id,code,name,type::account_type FROM location CROSS JOIN (VALUES
         ('1300','Inventory','asset'),('2100','AP','liability'),('1100','Cash','asset'),
         ('1120','Bank','asset'),('5100','COGS','expense'),('5150','Waste','expense'),
         ('5160','Count shortage','expense'),('4910','Count gain','revenue')
       ) a(code,name,type)
     ), item AS (
       INSERT INTO inventory_items(location_id,name,unit,avg_cost,carrying_value_rial)
       SELECT id,'Coffee beans','unit',$1::numeric,0 FROM location RETURNING id,location_id
     )
     SELECT location.business_id, location.id location_id, item.id inventory_item_id
     FROM location,item`,
    [avgCost],
  );
  return rows[0];
}

async function newEvent(
  client: Client,
  fixture: Fixture,
  eventType: string,
  sourceType: string,
  sourceId: string | null,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO inventory_events
       (business_id,location_id,event_type,source_type,source_id,costing_version)
     VALUES($1,$2,$3,$4,$5,2) RETURNING id`,
    [fixture.business_id, fixture.location_id, eventType, sourceType, sourceId],
  );
  return rows[0].id;
}

async function balances(client: Client, fixture: Fixture) {
  const { rows } = await client.query(
    `SELECT
       (SELECT trim_scale(COALESCE(sum(quantity),0))::text FROM stock_movements
         WHERE inventory_item_id=$1) physical,
       (SELECT trim_scale(COALESCE(sum(remaining_quantity),0))::text FROM inventory_negative_layers
         WHERE inventory_item_id=$1) open_negative,
       (SELECT COALESCE(sum(jl.debit-jl.credit),0)::text FROM journal_lines jl
         JOIN accounts a ON a.id=jl.account_id WHERE a.business_id=$2 AND a.code='1300') inventory_gl,
       (SELECT COALESCE(sum(jl.debit-jl.credit),0)::text FROM journal_lines jl
         JOIN accounts a ON a.id=jl.account_id WHERE a.business_id=$2 AND a.code='5100') cogs_gl,
       (SELECT COALESCE(sum(jl.debit-jl.credit),0)::text FROM journal_lines jl
         JOIN accounts a ON a.id=jl.account_id WHERE a.business_id=$2 AND a.code='5150') waste_gl,
       (SELECT COALESCE(sum(jl.debit-jl.credit),0)::text FROM journal_lines jl
         JOIN accounts a ON a.id=jl.account_id WHERE a.business_id=$2 AND a.code='4910') count_gain_gl`,
    [fixture.inventory_item_id, fixture.business_id],
  );
  return rows[0];
}

beforeAll(async () => {
  databaseName = `pos_exact_ops_${crypto.randomUUID().replaceAll("-", "")}`;
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

describe("exact operational consumption", () => {
  it("prices the negative layer a waste entry opens, so a later purchase still receives", async () => {
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client, "80");

    // Waste 1 unit of an item with no stock on hand.
    const wasteEvent = await newEvent(client, fixture, "waste", "waste", null);
    await client.query("UPDATE inventory_events SET source_id=id WHERE id=$1", [wasteEvent]);
    const waste = await consumeInventoryExact(client as never, {
      locationId: fixture.location_id,
      businessId: fixture.business_id,
      inventoryItemId: fixture.inventory_item_id,
      quantity: positiveQuantityText("1"),
      type: "waste",
      sourceType: "waste",
      sourceId: wasteEvent,
      wasteReason: "spoilage",
      createdBy: null,
      inventoryEventId: wasteEvent,
    });
    expect(waste.postedCost).toBe("80");
    await postExactOperationalInventoryEntry(client as never, {
      businessId: fixture.business_id,
      locationId: fixture.location_id,
      sourceType: "waste",
      sourceId: wasteEvent,
      postingKind: "waste",
      memo: "ضایعات",
      createdBy: null,
      inventoryEventId: wasteEvent,
      debitCode: WELL_KNOWN_CODES.wasteExpense,
      creditCode: WELL_KNOWN_CODES.inventory,
      amount: waste.postedCost,
    });

    // The layer must carry a provisional value; the legacy Number path left
    // these NULL, which made every later receipt for the item throw.
    const { rows: layers } = await client.query<{ opv: string | null; rpv: string | null }>(
      `SELECT original_provisional_value_rial::text opv, remaining_provisional_value_rial::text rpv
         FROM inventory_negative_layers WHERE inventory_item_id=$1`,
      [fixture.inventory_item_id],
    );
    expect(layers).toEqual([{ opv: "80", rpv: "80" }]);

    // A purchase at the real cost of 100 now settles it instead of failing.
    const { rows: purchase } = await client.query<{ purchase_id: string; purchase_item_id: string }>(
      `WITH purchase AS (
         INSERT INTO purchases(location_id,status,total) VALUES($1,'draft',100) RETURNING id
       ), line AS (
         INSERT INTO purchase_items(purchase_id,inventory_item_id,quantity,unit_cost,extended_cost)
         SELECT id,$2,1,100,100 FROM purchase RETURNING id
       )
       SELECT purchase.id purchase_id, line.id purchase_item_id FROM purchase,line`,
      [fixture.location_id, fixture.inventory_item_id],
    );
    const receiptEvent = await newEvent(client, fixture, "purchase_receipt", "purchase", purchase[0].purchase_id);
    const costing = await applyPurchaseReceiptCosting(client as never, {
      businessId: fixture.business_id,
      locationId: fixture.location_id,
      purchaseId: purchase[0].purchase_id,
      inventoryEventId: receiptEvent,
      createdBy: null,
      items: [{
        purchaseItemId: purchase[0].purchase_item_id,
        inventoryItemId: fixture.inventory_item_id,
        quantity: positiveQuantityText("1"),
        extendedCost: rialText("100"),
      }],
    });
    expect(costing.upwardSettlementAdjustment).toBe("20");
    await postExactPurchaseEntry(client as never, {
      businessId: fixture.business_id,
      locationId: fixture.location_id,
      purchaseId: purchase[0].purchase_id,
      createdBy: null,
      total: costing.receiptValue,
      settlementMethod: "credit",
      inventoryEventId: receiptEvent,
    });
    await postExactNegativeSettlementEntry(client as never, {
      businessId: fixture.business_id,
      locationId: fixture.location_id,
      sourceType: "purchase",
      sourceId: purchase[0].purchase_id,
      createdBy: null,
      upward: costing.upwardSettlementAdjustment,
      downward: costing.downwardSettlementAdjustment,
      inventoryEventId: receiptEvent,
    });

    // Physical, subledger and Inventory Asset all land at zero; the full 100
    // of actual cost sits in expense (80 waste + 20 settlement correction).
    expect(await balances(client, fixture)).toEqual({
      physical: "0",
      open_negative: "0",
      inventory_gl: "0",
      cogs_gl: "20",
      waste_gl: "80",
      count_gain_gl: "0",
    });
    await client.query("ROLLBACK");
    await client.end();
  });

  it("takes a stock-count variance exactly, with no double drift on 0.1 + 0.2", async () => {
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client, "100");

    // Two receipts of 0.1 and 0.2 — a double sums these to 0.30000000000000004.
    for (const quantity of ["0.1", "0.2"]) {
      const event = await newEvent(client, fixture, "purchase_receipt", "purchase", null);
      const { rows: purchase } = await client.query<{ purchase_id: string; purchase_item_id: string }>(
        `WITH purchase AS (
           INSERT INTO purchases(location_id,status,total) VALUES($1,'draft',10) RETURNING id
         ), line AS (
           INSERT INTO purchase_items(purchase_id,inventory_item_id,quantity,unit_cost,extended_cost)
           SELECT id,$2,$3::numeric,100,10 FROM purchase RETURNING id
         )
         SELECT purchase.id purchase_id, line.id purchase_item_id FROM purchase,line`,
        [fixture.location_id, fixture.inventory_item_id, quantity],
      );
      await client.query("UPDATE inventory_events SET source_id=$2 WHERE id=$1", [event, purchase[0].purchase_id]);
      await applyPurchaseReceiptCosting(client as never, {
        businessId: fixture.business_id,
        locationId: fixture.location_id,
        purchaseId: purchase[0].purchase_id,
        inventoryEventId: event,
        createdBy: null,
        items: [{
          purchaseItemId: purchase[0].purchase_item_id,
          inventoryItemId: fixture.inventory_item_id,
          quantity: positiveQuantityText(quantity),
          extendedCost: rialText("10"),
        }],
      });
    }

    const { rows: stock } = await client.query<{ quantity: string }>(
      "SELECT COALESCE(sum(quantity),0)::text quantity FROM stock_movements WHERE inventory_item_id=$1",
      [fixture.inventory_item_id],
    );
    // Counting exactly what is on hand must be a true no-op.
    const { rows: count } = await client.query<{ id: string }>(
      "INSERT INTO stock_counts(location_id) VALUES($1) RETURNING id",
      [fixture.location_id],
    );
    const countEvent = await newEvent(client, fixture, "stock_count_adjustment", "stock_count", count[0].id);
    const result = await applyStockAdjustmentExact(client as never, {
      locationId: fixture.location_id,
      businessId: fixture.business_id,
      inventoryItemId: fixture.inventory_item_id,
      delta: "0",
      stockCountId: count[0].id,
      sourceType: "stock_count",
      sourceId: count[0].id,
      createdBy: null,
      inventoryEventId: countEvent,
    });
    expect(stock[0].quantity).toBe("0.300000000");
    expect(result.varianceValueRial).toBe("0");

    // No adjustment movement, and no phantom negative layer, was written.
    const { rows: movements } = await client.query<{ count: string }>(
      "SELECT count(*)::text count FROM stock_movements WHERE inventory_item_id=$1 AND type='adjustment'",
      [fixture.inventory_item_id],
    );
    expect(movements[0].count).toBe("0");
    const after = await balances(client, fixture);
    expect(after.physical).toBe("0.3");
    expect(after.open_negative).toBe("0");
    await client.query("ROLLBACK");
    await client.end();
  });

  it("settles an open negative layer from a stock-count surplus and corrects the cost difference", async () => {
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client, "80");

    const wasteEvent = await newEvent(client, fixture, "waste", "waste", null);
    await client.query("UPDATE inventory_events SET source_id=id WHERE id=$1", [wasteEvent]);
    const waste = await consumeInventoryExact(client as never, {
      locationId: fixture.location_id,
      businessId: fixture.business_id,
      inventoryItemId: fixture.inventory_item_id,
      quantity: positiveQuantityText("1"),
      type: "waste",
      sourceType: "waste",
      sourceId: wasteEvent,
      wasteReason: "spoilage",
      createdBy: null,
      inventoryEventId: wasteEvent,
    });
    await postExactOperationalInventoryEntry(client as never, {
      businessId: fixture.business_id,
      locationId: fixture.location_id,
      sourceType: "waste",
      sourceId: wasteEvent,
      postingKind: "waste",
      memo: "ضایعات",
      createdBy: null,
      inventoryEventId: wasteEvent,
      debitCode: WELL_KNOWN_CODES.wasteExpense,
      creditCode: WELL_KNOWN_CODES.inventory,
      amount: waste.postedCost,
    });

    // Replacement cost has moved to 100 by the time the shelf is counted.
    await client.query("UPDATE inventory_items SET avg_cost=100 WHERE id=$1", [fixture.inventory_item_id]);
    const { rows: count } = await client.query<{ id: string }>(
      "INSERT INTO stock_counts(location_id) VALUES($1) RETURNING id",
      [fixture.location_id],
    );
    const countEvent = await newEvent(client, fixture, "stock_count_adjustment", "stock_count", count[0].id);
    // System says -1, the shelf says 0 → +1 surplus closes the layer.
    const result = await applyStockAdjustmentExact(client as never, {
      locationId: fixture.location_id,
      businessId: fixture.business_id,
      inventoryItemId: fixture.inventory_item_id,
      delta: "1",
      stockCountId: count[0].id,
      sourceType: "stock_count",
      sourceId: count[0].id,
      createdBy: null,
      inventoryEventId: countEvent,
    });
    expect(result.varianceValueRial).toBe("100");
    expect(result.upwardSettlementAdjustment).toBe("20");

    await postExactStockCountEntry(client as never, {
      businessId: fixture.business_id,
      locationId: fixture.location_id,
      stockCountId: count[0].id,
      inventoryEventId: countEvent,
      createdBy: null,
      shortageValue: rialText("0"),
      surplusValue: rialText(result.varianceValueRial),
    });
    await postExactNegativeSettlementEntry(client as never, {
      businessId: fixture.business_id,
      locationId: fixture.location_id,
      sourceType: "stock_count",
      sourceId: count[0].id,
      createdBy: null,
      upward: result.upwardSettlementAdjustment,
      downward: result.downwardSettlementAdjustment,
      inventoryEventId: countEvent,
    });

    // The count settled the shortage, so no phantom layer is left for a
    // future purchase to consume, and Inventory Asset returns to zero.
    expect(await balances(client, fixture)).toEqual({
      physical: "0",
      open_negative: "0",
      inventory_gl: "0",
      cogs_gl: "20",
      waste_gl: "80",
      count_gain_gl: "-100",
    });
    const { rows: settlements } = await client.query<{ count: string; difference: string }>(
      `SELECT count(*)::text count, COALESCE(sum(difference_rial),0)::text difference
         FROM inventory_negative_layer_settlements WHERE stock_count_id=$1`,
      [count[0].id],
    );
    expect(settlements[0]).toEqual({ count: "1", difference: "20" });
    await client.query("ROLLBACK");
    await client.end();
  });
});
