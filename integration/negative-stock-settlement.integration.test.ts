import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { consumeInventoryExact } from "../src/lib/inventory-consumption-exact";
import { applyPurchaseReceiptCosting } from "../src/lib/purchase-receipt-costing";
import { postExactCogsEntry, postExactPurchaseEntry, postNegativeStockSettlementEntry } from "../src/lib/ledger-service";
import { quantityText, rialText } from "../src/lib/inventory-exact";

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

beforeAll(async () => {
  databaseName = `pos_cost_${crypto.randomUUID().replaceAll("-", "")}`;
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

describe("negative-stock exact cost settlement", () => {
  it("corrects provisional COGS 80 to receipt cost 100 and leaves inventory at zero", async () => {
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await client.query<{
      business_id: string;
      location_id: string;
      inventory_item_id: string;
      order_id: string;
      sale_event_id: string;
    }>(`
      WITH business AS (
        INSERT INTO businesses(name) VALUES('Exact Cost Test') RETURNING id
      ), location AS (
        INSERT INTO locations(business_id,name) SELECT id,'Main' FROM business RETURNING id,business_id
      ), costing AS (
        INSERT INTO settings(business_id,key,value)
        SELECT business_id,'inventory.costing','{"method":"fifo"}'::jsonb FROM location
      ), accounts_created AS (
        INSERT INTO accounts(business_id,code,name,type)
        SELECT business_id,code,name,type::account_type FROM location CROSS JOIN (VALUES
          ('1300','Inventory','asset'),('2100','AP','liability'),('1100','Cash','asset'),
          ('1120','Bank','asset'),('5100','COGS','expense')
        ) a(code,name,type)
      ), item AS (
        INSERT INTO inventory_items(location_id,name,unit,avg_cost,carrying_value_rial)
        SELECT id,'Coffee beans','unit',80,0 FROM location RETURNING id,location_id
      ), sale_order AS (
        INSERT INTO orders(location_id,order_number,status,total)
        SELECT location_id,1,'completed',0 FROM item RETURNING id,location_id
      ), sale_event AS (
        INSERT INTO inventory_events
          (business_id,location_id,event_type,source_type,source_id,costing_version)
        SELECT location.business_id,location.id,'sale_consumption','order',sale_order.id,2
        FROM location,sale_order RETURNING id
      )
      SELECT location.business_id,location.id location_id,item.id inventory_item_id,
             sale_order.id order_id,sale_event.id sale_event_id
      FROM location,item,sale_order,sale_event
    `);
    const row = fixture.rows[0];

    const sale = await consumeInventoryExact(client as never, {
      businessId: row.business_id,
      locationId: row.location_id,
      inventoryItemId: row.inventory_item_id,
      quantity: quantityText("1"),
      type: "sale",
      sourceType: "order",
      sourceId: row.order_id,
      createdBy: null,
      inventoryEventId: row.sale_event_id,
    });
    expect(sale.postedCost).toBe("80");
    await postExactCogsEntry(client as never, {
      businessId: row.business_id,
      locationId: row.location_id,
      orderId: row.order_id,
      createdBy: null,
      totalCost: sale.postedCost,
      inventoryEventId: row.sale_event_id,
    });

    const purchase = await client.query<{ purchase_id: string; purchase_item_id: string }>(
      `WITH purchase AS (
         INSERT INTO purchases(location_id,status,total)
         VALUES($1,'draft',100) RETURNING id
       ), line AS (
         INSERT INTO purchase_items(purchase_id,inventory_item_id,quantity,unit_cost,extended_cost)
         SELECT id,$2,1,100,100 FROM purchase RETURNING id
       )
       SELECT purchase.id purchase_id,line.id purchase_item_id FROM purchase,line`,
      [row.location_id, row.inventory_item_id],
    );
    const receiptEvent = await client.query<{ id: string }>(
      `INSERT INTO inventory_events
         (business_id,location_id,event_type,source_type,source_id,costing_version)
       VALUES($1,$2,'purchase_receipt','purchase',$3,2) RETURNING id`,
      [row.business_id, row.location_id, purchase.rows[0].purchase_id],
    );
    const costing = await applyPurchaseReceiptCosting(client as never, {
      businessId: row.business_id,
      locationId: row.location_id,
      purchaseId: purchase.rows[0].purchase_id,
      inventoryEventId: receiptEvent.rows[0].id,
      createdBy: null,
      items: [{
        purchaseItemId: purchase.rows[0].purchase_item_id,
        inventoryItemId: row.inventory_item_id,
        quantity: quantityText("1"),
        extendedCost: rialText("100"),
      }],
    });
    expect(costing).toEqual({
      receiptValue: "100",
      upwardSettlementAdjustment: "20",
      downwardSettlementAdjustment: "0",
    });
    await postExactPurchaseEntry(client as never, {
      businessId: row.business_id,
      locationId: row.location_id,
      purchaseId: purchase.rows[0].purchase_id,
      createdBy: null,
      total: costing.receiptValue,
      settlementMethod: "credit",
      inventoryEventId: receiptEvent.rows[0].id,
    });
    await postNegativeStockSettlementEntry(client as never, {
      businessId: row.business_id,
      locationId: row.location_id,
      purchaseId: purchase.rows[0].purchase_id,
      createdBy: null,
      upward: costing.upwardSettlementAdjustment,
      downward: costing.downwardSettlementAdjustment,
      inventoryEventId: receiptEvent.rows[0].id,
    });
    await client.query("COMMIT");

    const balances = await client.query<{
      physical: string;
      open_negative: string;
      inventory_gl: string;
      cogs_gl: string;
      settlement_difference: string;
    }>(
      `SELECT
         (SELECT trim_scale(COALESCE(sum(quantity),0))::text
            FROM stock_movements WHERE inventory_item_id=$1) physical,
         (SELECT trim_scale(COALESCE(sum(remaining_quantity),0))::text FROM inventory_negative_layers
           WHERE inventory_item_id=$1) open_negative,
         (SELECT COALESCE(sum(jl.debit-jl.credit),0)::text FROM journal_lines jl
           JOIN accounts a ON a.id=jl.account_id WHERE a.business_id=$2 AND a.code='1300') inventory_gl,
         (SELECT COALESCE(sum(jl.debit-jl.credit),0)::text FROM journal_lines jl
           JOIN accounts a ON a.id=jl.account_id WHERE a.business_id=$2 AND a.code='5100') cogs_gl,
         (SELECT difference_rial::text FROM inventory_negative_layer_settlements LIMIT 1) settlement_difference`,
      [row.inventory_item_id, row.business_id],
    );
    expect(balances.rows[0]).toEqual({
      physical: "0",
      open_negative: "0",
      inventory_gl: "0",
      cogs_gl: "100",
      settlement_difference: "20",
    });
    await client.end();
  });
});
