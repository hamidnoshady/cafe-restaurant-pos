/**
 * Selling an ingredient that has no cost yet, against a real database.
 *
 * inventory_items.avg_cost defaults to 0, so an ingredient that was never
 * purchased prices a shortfall at nothing: the negative layer carries its full
 * quantity and zero value. Migration 0015's biconditional forbade exactly that
 * row, so the sale died at checkout with a 23514 — an order that could never be
 * closed. Migration 0074 keeps the half of that rule which protects the ledger
 * (a settled layer strands no value) and drops the half that misdescribed an
 * unpriced shortfall.
 *
 * What this pins down:
 *   1. the sale goes through, at zero provisional cost, flagged is_unpriced;
 *   2. a partially settled layer may also sit at zero value with quantity left;
 *   3. the purchase that settles it books its whole actual cost as an upward
 *      variance — the correct treatment for stock consumed before its price
 *      was known;
 *   4. a priced shortfall still behaves as it always did;
 *   5. the retained half of the constraint still rejects value stranded on a
 *      fully settled layer.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { consumeInventoryExact } from "../src/lib/inventory-consumption-exact";
import { applyPurchaseReceiptCosting } from "../src/lib/purchase-receipt-costing";
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

interface Fixture {
  business_id: string;
  location_id: string;
  inventory_item_id: string;
  order_id: string;
  sale_event_id: string;
}

/**
 * A branch with one ingredient and one open sale to consume it. `avgCost` 0 is
 * the never-purchased ingredient this whole file is about.
 */
async function seed(client: Client, avgCost: string): Promise<Fixture> {
  const { rows } = await client.query<Fixture>(
    `WITH business AS (
       INSERT INTO businesses(name,slug) VALUES('Unpriced Stock Test',$1) RETURNING id
     ), location AS (
       INSERT INTO locations(business_id,name) SELECT id,'Main' FROM business RETURNING id,business_id
     ), item AS (
       INSERT INTO inventory_items(location_id,name,unit,avg_cost,carrying_value_rial)
       SELECT id,'لیمو','g',$2::numeric,0 FROM location RETURNING id,location_id
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
     FROM location,item,sale_order,sale_event`,
    [`unpriced-${randomUUID().slice(0, 8)}`, avgCost],
  );
  return rows[0];
}

function sell(client: Client, fixture: Fixture, quantity: string) {
  return consumeInventoryExact(client as never, {
    businessId: fixture.business_id,
    locationId: fixture.location_id,
    inventoryItemId: fixture.inventory_item_id,
    quantity: quantityText(quantity),
    type: "sale",
    sourceType: "order",
    sourceId: fixture.order_id,
    createdBy: null,
    inventoryEventId: fixture.sale_event_id,
  });
}

/** A receipt for the same ingredient, which settles whatever shortfall is open. */
async function receive(client: Client, fixture: Fixture, quantity: string, extendedCost: string) {
  const purchase = await client.query<{ purchase_id: string; purchase_item_id: string }>(
    `WITH purchase AS (
       INSERT INTO purchases(location_id,status,total) VALUES($1,'draft',$4::bigint) RETURNING id
     ), line AS (
       INSERT INTO purchase_items(purchase_id,inventory_item_id,quantity,unit_cost,extended_cost)
       SELECT id,$2,$3::numeric,$4::numeric/$3::numeric,$4::bigint FROM purchase RETURNING id
     )
     SELECT purchase.id purchase_id,line.id purchase_item_id FROM purchase,line`,
    [fixture.location_id, fixture.inventory_item_id, quantity, extendedCost],
  );
  const receiptEvent = await client.query<{ id: string }>(
    `INSERT INTO inventory_events
       (business_id,location_id,event_type,source_type,source_id,costing_version)
     VALUES($1,$2,'purchase_receipt','purchase',$3,2) RETURNING id`,
    [fixture.business_id, fixture.location_id, purchase.rows[0].purchase_id],
  );
  return applyPurchaseReceiptCosting(client as never, {
    businessId: fixture.business_id,
    locationId: fixture.location_id,
    purchaseId: purchase.rows[0].purchase_id,
    inventoryEventId: receiptEvent.rows[0].id,
    createdBy: null,
    items: [{
      purchaseItemId: purchase.rows[0].purchase_item_id,
      inventoryItemId: fixture.inventory_item_id,
      quantity: quantityText(quantity),
      extendedCost: rialText(extendedCost),
    }],
  });
}

async function layers(client: Client, fixture: Fixture) {
  const { rows } = await client.query<{
    remaining_quantity: string;
    original_provisional_value_rial: string | null;
    remaining_provisional_value_rial: string | null;
    is_unpriced: boolean;
    settled: boolean;
  }>(
    `SELECT trim_scale(remaining_quantity)::text remaining_quantity,
            original_provisional_value_rial::text,
            remaining_provisional_value_rial::text,
            is_unpriced, (settled_at IS NOT NULL) settled
       FROM inventory_negative_layers WHERE inventory_item_id=$1 ORDER BY created_at,id`,
    [fixture.inventory_item_id],
  );
  return rows;
}

beforeAll(async () => {
  databaseName = `pos_unpriced_${randomUUID().replaceAll("-", "")}`;
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

describe("selling an ingredient that has no cost yet", () => {
  it("completes the sale and records the shortfall as an unpriced layer", async () => {
    const client = await connect();
    try {
      await client.query("BEGIN");
      const fixture = await seed(client, "0");

      const sale = await sell(client, fixture, "5");
      expect(sale.postedCost).toBe("0");

      expect(await layers(client, fixture)).toEqual([
        {
          remaining_quantity: "5",
          original_provisional_value_rial: "0",
          remaining_provisional_value_rial: "0",
          is_unpriced: true,
          settled: false,
        },
      ]);
      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
  });

  it("leaves a partially settled layer outstanding at zero value", async () => {
    const client = await connect();
    try {
      await client.query("BEGIN");
      const fixture = await seed(client, "0");
      await sell(client, fixture, "5");

      const costing = await receive(client, fixture, "2", "600");
      expect(costing.upwardSettlementAdjustment).toBe("600");
      expect(costing.downwardSettlementAdjustment).toBe("0");

      // Three of the five are still owed, and still worth nothing on paper —
      // the shape migration 0015 rejected mid-settlement.
      expect(await layers(client, fixture)).toEqual([
        {
          remaining_quantity: "3",
          original_provisional_value_rial: "0",
          remaining_provisional_value_rial: "0",
          is_unpriced: true,
          settled: false,
        },
      ]);
      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
  });

  it("books the settling purchase's whole cost as an upward variance", async () => {
    const client = await connect();
    try {
      await client.query("BEGIN");
      const fixture = await seed(client, "0");
      await sell(client, fixture, "5");

      const costing = await receive(client, fixture, "5", "1000");
      expect(costing).toEqual({
        receiptValue: "1000",
        upwardSettlementAdjustment: "1000",
        downwardSettlementAdjustment: "0",
      });

      const [layer] = await layers(client, fixture);
      expect(layer.remaining_quantity).toBe("0");
      expect(layer.remaining_provisional_value_rial).toBe("0");
      expect(layer.settled).toBe(true);
      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
  });

  it("still prices a shortfall whose ingredient does have a cost", async () => {
    const client = await connect();
    try {
      await client.query("BEGIN");
      const fixture = await seed(client, "80");

      const sale = await sell(client, fixture, "2");
      expect(sale.postedCost).toBe("160");

      expect(await layers(client, fixture)).toEqual([
        {
          remaining_quantity: "2",
          original_provisional_value_rial: "160",
          remaining_provisional_value_rial: "160",
          is_unpriced: false,
          settled: false,
        },
      ]);
      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
  });

  it("still refuses to strand value on a fully settled layer", async () => {
    const client = await connect();
    try {
      await client.query("BEGIN");
      const fixture = await seed(client, "80");
      await sell(client, fixture, "2");

      // settled_at moves with the quantity, or the separate settled-marker
      // constraint fires first and this proves nothing about the value bounds.
      await expect(
        client.query(
          `UPDATE inventory_negative_layers
              SET remaining_quantity=0, settled_at=now()
            WHERE inventory_item_id=$1`,
          [fixture.inventory_item_id],
        ),
      ).rejects.toThrow(/negative_layer_exact_value_bounds/);
      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
  });
});
