import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lockOpenOrder } from "../src/lib/order-lock";
import { runMigrations } from "../scripts/migrate";

const configuredUrl = process.env.DATABASE_URL;
if (!configuredUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName = "";
let databaseUrl = "";
let locationId = "";
let orderId = "";
let itemId = "";

function urlFor(database: string): string {
  const url = new URL(configuredUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  return urlFor("postgres");
}

async function connect(url = databaseUrl): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

async function backendPid(client: Client): Promise<number> {
  const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return result.rows[0].pid;
}

async function waitUntilBlocked(observer: Client, blockedPid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ waiting: boolean }>(
      `SELECT wait_event_type = 'Lock' AS waiting
         FROM pg_stat_activity WHERE pid = $1`,
      [blockedPid],
    );
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`client ${blockedPid} did not block on the order lock`);
}

beforeEach(async () => {
  databaseName = `pos_order_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = await connect(maintenanceUrl());
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  await admin.end();
  databaseUrl = urlFor(databaseName);
  await runMigrations({ databaseUrl, quiet: true });

  const seed = await connect();
  const fixture = await seed.query<{ location_id: string; order_id: string; item_id: string }>(`
    WITH business AS (
      INSERT INTO businesses(name) VALUES('Concurrency Test') RETURNING id
    ), location AS (
      INSERT INTO locations(business_id,name) SELECT id,'Main' FROM business RETURNING id
    ), new_order AS (
      INSERT INTO orders(location_id,order_number,status,subtotal,total)
      SELECT id,1,'open',100,100 FROM location RETURNING id,location_id
    ), new_item AS (
      INSERT INTO order_items(location_id,order_id,name_snapshot,unit_price,quantity,status)
      SELECT location_id,id,'Coffee',100,1,'sent' FROM new_order RETURNING id
    )
    SELECT new_order.location_id, new_order.id order_id, new_item.id item_id
      FROM new_order CROSS JOIN new_item
  `);
  ({ location_id: locationId, order_id: orderId, item_id: itemId } = fixture.rows[0]);
  await seed.end();
});

afterEach(async () => {
  if (!databaseName) return;
  const admin = await connect(maintenanceUrl());
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.end();
});

describe("order/payment serialization", () => {
  it("lets an item mutation finish first, then payment observes its committed totals", async () => {
    const mutation = await connect();
    const payment = await connect();
    const observer = await connect();
    await mutation.query("BEGIN");
    expect((await lockOpenOrder(mutation as never, locationId, orderId)).ok).toBe(true);
    await mutation.query("UPDATE order_items SET quantity=2 WHERE id=$1", [itemId]);
    await mutation.query("UPDATE orders SET subtotal=200,total=200 WHERE id=$1", [orderId]);

    await payment.query("BEGIN");
    const paymentPid = await backendPid(payment);
    const lockedPayment = lockOpenOrder(payment as never, locationId, orderId);
    await waitUntilBlocked(observer, paymentPid);
    await mutation.query("COMMIT");

    const paymentResult = await lockedPayment;
    expect(paymentResult.ok && paymentResult.order.total).toBe("200");
    await payment.query(
      "UPDATE orders SET status='completed' WHERE id=$1 AND status='open' RETURNING id",
      [orderId],
    );
    await payment.query("COMMIT");
    await Promise.all([mutation.end(), payment.end(), observer.end()]);
  });

  it("returns order_not_open without item side effects when payment wins", async () => {
    const payment = await connect();
    const mutation = await connect();
    const observer = await connect();
    await payment.query("BEGIN");
    expect((await lockOpenOrder(payment as never, locationId, orderId)).ok).toBe(true);
    await payment.query(
      "UPDATE orders SET status='completed' WHERE id=$1 AND status='open' RETURNING id",
      [orderId],
    );

    await mutation.query("BEGIN");
    const mutationPid = await backendPid(mutation);
    const lockedMutation = lockOpenOrder(mutation as never, locationId, orderId);
    await waitUntilBlocked(observer, mutationPid);
    await payment.query("COMMIT");

    await expect(lockedMutation).resolves.toEqual({ ok: false, error: "order_not_open", status: 409 });
    await mutation.query("ROLLBACK");
    const quantity = await observer.query<{ quantity: number }>("SELECT quantity FROM order_items WHERE id=$1", [itemId]);
    expect(quantity.rows[0].quantity).toBe(1);
    await Promise.all([payment.end(), mutation.end(), observer.end()]);
  });

  it("permits only one positive payment while allowing negative refunds", async () => {
    const client = await connect();
    await client.query(
      "INSERT INTO payments(location_id,order_id,method,amount) VALUES($1,$2,'cash',100)",
      [locationId, orderId],
    );
    await expect(
      client.query("INSERT INTO payments(location_id,order_id,method,amount) VALUES($1,$2,'card',100)", [
        locationId,
        orderId,
      ]),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      client.query("INSERT INTO payments(location_id,order_id,method,amount) VALUES($1,$2,'cash',-20)", [
        locationId,
        orderId,
      ]),
    ).resolves.toBeDefined();
    await client.end();
  });

  it("allows kitchen-only status progress but rejects financial changes after completion", async () => {
    const client = await connect();
    await client.query("UPDATE orders SET status='completed' WHERE id=$1", [orderId]);
    await expect(client.query("UPDATE order_items SET status='ready' WHERE id=$1", [itemId])).resolves.toBeDefined();
    await expect(client.query("UPDATE order_items SET quantity=2 WHERE id=$1", [itemId])).rejects.toMatchObject({
      code: "55000",
      message: "order_not_open",
    });
    await expect(
      client.query(
        `INSERT INTO order_items(location_id,order_id,name_snapshot,unit_price,quantity)
         VALUES($1,$2,'Late item',100,1)`,
        [locationId, orderId],
      ),
    ).rejects.toMatchObject({ code: "55000", message: "order_not_open" });
    await client.end();
  });
});
