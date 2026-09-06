/**
 * Closed-order amendments: editing or removing an order that has already been
 * paid for, and proving the accounting actually moves with it.
 *
 * The point of these tests is the *whole* effect, not the order row: after a
 * removal nothing in the books, the stock ledger, the till or the customer's
 * A/R may still show the sale, and after an edit all four must show the
 * corrected amounts — on the day the order was sold, not on the day the
 * correction was made.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let amendmentService: typeof import("../src/lib/order-amendment-service");
let inventoryService: typeof import("../src/lib/inventory-service");
let ledgerService: typeof import("../src/lib/ledger-service");
let amendments: typeof import("../src/lib/order-amendments");

const biz = { id: "", locationId: "", menuItemId: "", secondMenuItemId: "", inventoryItemId: "", customerId: "" };

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_order_amend_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  amendmentService = await import("../src/lib/order-amendment-service");
  inventoryService = await import("../src/lib/inventory-service");
  ledgerService = await import("../src/lib/ledger-service");
  amendments = await import("../src/lib/order-amendments");
  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 180_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

const ACCOUNTS: [string, string, string][] = [
  ["1100", "Cash", "asset"],
  ["1120", "Card clearing", "asset"],
  ["1200", "Accounts Receivable", "asset"],
  ["1230", "Platform Receivable", "asset"],
  ["1300", "Inventory", "asset"],
  ["2100", "Accounts Payable", "liability"],
  ["2200", "VAT Payable", "liability"],
  ["2400", "Tips Payable", "liability"],
  ["4310", "Dine-in revenue", "revenue"],
  ["4320", "Takeaway revenue", "revenue"],
  ["4330", "Delivery revenue", "revenue"],
  ["4400", "Sales returns", "revenue"],
  ["5100", "COGS", "expense"],
  ["5650", "Platform commission", "expense"],
];

// Each test gets its own business, location and stock; nothing is deleted
// between them (inventory_events deliberately RESTRICTs its business away),
// and every assertion is scoped to the business or item it created.
let orderNumber = 0;

beforeEach(async () => {
  const { rows: business } = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Amend Co', $1) RETURNING id",
    [`amend-${randomUUID().slice(0, 8)}`],
  );
  biz.id = business[0].id;
  const { rows: location } = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = location[0].id;
  await db.query(
    `INSERT INTO accounts (business_id, code, name, type)
     SELECT $1, code, name, type::account_type FROM UNNEST($2::text[], $3::text[], $4::text[]) AS a(code, name, type)`,
    [biz.id, ACCOUNTS.map((a) => a[0]), ACCOUNTS.map((a) => a[1]), ACCOUNTS.map((a) => a[2])],
  );
  await db.query(`INSERT INTO settings (business_id, key, value) VALUES ($1, 'inventory.costing', '{"method":"fifo"}'::jsonb)`, [biz.id]);

  const { rows: customer } = await db.query<{ id: string }>(
    "INSERT INTO parties (business_id, name) VALUES ($1, 'مشتری اعتباری') RETURNING id",
    [biz.id],
  );
  biz.customerId = customer[0].id;

  const { rows: category } = await db.query<{ id: string }>(
    "INSERT INTO menu_categories (location_id, name, tax_rate) VALUES ($1, 'نوشیدنی', 10) RETURNING id",
    [biz.locationId],
  );
  const { rows: menuItems } = await db.query<{ id: string }>(
    `INSERT INTO menu_items (location_id, category_id, name, price)
     VALUES ($1, $2, 'اسپرسو', 100000), ($1, $2, 'لاته', 150000) RETURNING id`,
    [biz.locationId, category[0].id],
  );
  biz.menuItemId = menuItems[0].id;
  biz.secondMenuItemId = menuItems[1].id;

  const { rows: inventoryItem } = await db.query<{ id: string }>(
    `INSERT INTO inventory_items (location_id, name, unit, avg_cost, carrying_value_rial)
     VALUES ($1, 'دانه قهوه', 'gram', 0, 0) RETURNING id`,
    [biz.locationId],
  );
  biz.inventoryItemId = inventoryItem[0].id;
  await db.query(
    `INSERT INTO menu_item_ingredients (menu_item_id, inventory_item_id, quantity)
     VALUES ($1, $3, 10), ($2, $3, 20)`,
    [biz.menuItemId, biz.secondMenuItemId, biz.inventoryItemId],
  );

  // 1000 g of stock at 500 Rial/g, as a FIFO lot with an exact cost basis.
  const { rows: stockEvent } = await db.query<{ id: string }>(
    `INSERT INTO inventory_events (business_id, location_id, event_type, source_type, source_id, costing_version, posting_status)
     VALUES ($1, $2, 'purchase_receipt', 'purchase', $3, 2, 'posted') RETURNING id`,
    [biz.id, biz.locationId, randomUUID()],
  );
  await db.query(
    `INSERT INTO inventory_lots (location_id, inventory_item_id, remaining_qty, unit_cost, remaining_value_rial,
                                 source_type, source_id, inventory_event_id, original_quantity, original_value_rial)
     VALUES ($1, $2, 1000, 500, 500000, 'purchase', $3, $4, 1000, 500000)`,
    [biz.locationId, biz.inventoryItemId, randomUUID(), stockEvent[0].id],
  );
  await db.query(
    `INSERT INTO stock_movements (location_id, inventory_item_id, type, quantity, unit_cost, cost_value_rial,
                                  source_type, source_id, inventory_event_id)
     VALUES ($1, $2, 'purchase', 1000, 500, 500000, 'purchase', $3, $4)`,
    [biz.locationId, biz.inventoryItemId, randomUUID(), stockEvent[0].id],
  );
  await db.query("UPDATE inventory_items SET avg_cost = 500, carrying_value_rial = 500000 WHERE id = $1", [
    biz.inventoryItemId,
  ]);
});

interface SoldOrder {
  id: string;
  itemIds: string[];
  total: number;
}

/**
 * An order sold and paid for on `soldOn`, through the same sequence
 * /api/orders/[id]/pay runs: consumption event, payment row, completion,
 * exact deduction, revenue entry, COGS entry.
 */
async function sellOrder(options: {
  lines: { menuItemId: string; quantity: number }[];
  method: "cash" | "card" | "credit";
  soldOn: string;
  tip?: number;
  type?: "dine_in" | "takeaway" | "delivery";
  customerId?: string | null;
  /** a delivery order's flat fee, which rides on service_charge */
  deliveryFee?: number;
}): Promise<SoldOrder> {
  const client = await dbLib.getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: orders } = await client.query<{ id: string }>(
      `INSERT INTO orders (location_id, order_number, type, status, customer_id, subtotal, tax, total, service_charge, opened_at)
       VALUES ($1, $5, $2, 'open', $3, 0, 0, 0, $6, $4::timestamptz) RETURNING id`,
      [
        biz.locationId,
        options.type ?? "dine_in",
        options.customerId ?? null,
        `${options.soldOn}T10:00:00Z`,
        ++orderNumber,
        options.deliveryFee ?? 0,
      ],
    );
    const orderId = orders[0].id;
    const itemIds: string[] = [];
    for (const line of options.lines) {
      const { rows: prices } = await client.query<{ price: string; name: string }>(
        "SELECT price::text, name FROM menu_items WHERE id = $1",
        [line.menuItemId],
      );
      const { rows: items } = await client.query<{ id: string }>(
        `INSERT INTO order_items (location_id, order_id, menu_item_id, name_snapshot, unit_price, quantity, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'served') RETURNING id`,
        [biz.locationId, orderId, line.menuItemId, prices[0].name, prices[0].price, line.quantity],
      );
      itemIds.push(items[0].id);
      await client.query(
        `INSERT INTO order_item_inventory_snapshots (order_item_id, inventory_item_id, required_quantity, source_menu_item_id)
         SELECT $1, inventory_item_id, quantity, menu_item_id FROM menu_item_ingredients WHERE menu_item_id = $2`,
        [items[0].id, line.menuItemId],
      );
    }
    const { recomputeOrderTotals } = await import("../src/lib/order-totals");
    const totals = await recomputeOrderTotals(client, orderId, { type: null });

    const { rows: events } = await client.query<{ id: string }>(
      `INSERT INTO inventory_events (business_id, location_id, event_type, source_type, source_id, costing_version, idempotency_key)
       VALUES ($1, $2, 'sale_consumption', 'order', $3, 2, $4) RETURNING id`,
      [biz.id, biz.locationId, orderId, `order-payment:${orderId}`],
    );
    const eventId = events[0].id;
    await client.query(
      `INSERT INTO payments (location_id, order_id, method, amount) VALUES ($1, $2, $3, $4)`,
      [biz.locationId, orderId, options.method, totals.total],
    );
    await client.query(
      `UPDATE orders SET status = 'completed', closed_at = $2::timestamptz, tip_amount = $3 WHERE id = $1`,
      [orderId, `${options.soldOn}T11:00:00Z`, options.tip ?? 0],
    );
    // A sale made a week ago recorded its stock movements on that day, so the
    // fixture dates them there too rather than at test-run time.
    const { totalCost } = await inventoryService.deductForOrder(
      client,
      biz.id,
      biz.locationId,
      orderId,
      null,
      eventId,
      `${options.soldOn}T11:00:00Z`,
    );
    await ledgerService.postExactOrderPaymentEntry(client, {
      businessId: biz.id,
      locationId: biz.locationId,
      orderId,
      createdBy: null,
      method: options.method,
      amount: String(totals.total) as never,
      tax: String(totals.tax) as never,
      inventoryEventId: eventId,
      orderChannel: options.type ?? "dine_in",
      tip: String(options.tip ?? 0) as never,
      entryDate: options.soldOn,
    });
    await ledgerService.postExactCogsEntry(client, {
      businessId: biz.id,
      locationId: biz.locationId,
      orderId,
      createdBy: null,
      totalCost,
      inventoryEventId: eventId,
      entryDate: options.soldOn,
    });
    await client.query("UPDATE inventory_events SET posting_status = 'posted' WHERE id = $1", [eventId]);
    await client.query("COMMIT");
    return { id: orderId, itemIds, total: totals.total };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function amend(orderId: string, input: Parameters<typeof amendments.validateAmendment>[0]) {
  const validated = amendments.validateAmendment(input);
  if (!validated.ok) throw new Error(validated.error);
  const client = await dbLib.getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await amendmentService.amendClosedOrder(client, {
      businessId: biz.id,
      locationId: biz.locationId,
      orderId,
      actorId: null,
      input: validated.value,
    });
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Net movement on one account code, optionally restricted to one entry date. */
async function accountBalance(code: string, onDate?: string): Promise<number> {
  const { rows } = await db.query<{ balance: string }>(
    `SELECT COALESCE(sum(jl.debit - jl.credit), 0)::text AS balance
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id
      WHERE a.business_id = $1 AND a.code = $2
        AND ($3::date IS NULL OR je.entry_date = $3::date)`,
    [biz.id, code, onDate ?? null],
  );
  return Number(rows[0].balance);
}

async function physicalStock(): Promise<number> {
  const { rows } = await db.query<{ quantity: string }>(
    "SELECT COALESCE(sum(quantity), 0)::text AS quantity FROM stock_movements WHERE inventory_item_id = $1",
    [biz.inventoryItemId],
  );
  return Number(rows[0].quantity);
}

async function stockValue(): Promise<number> {
  const { rows } = await db.query<{ value: string }>(
    "SELECT COALESCE(sum(remaining_value_rial), 0)::text AS value FROM inventory_lots WHERE inventory_item_id = $1",
    [biz.inventoryItemId],
  );
  return Number(rows[0].value);
}

/**
 * Net stock movement caused by orders on one calendar day, by the movement's
 * own date — the opening purchase the fixture books is excluded, so this is
 * exactly what the sale and its correction did to the stock ledger.
 */
async function stockMovedOn(day: string): Promise<number> {
  const { rows } = await db.query<{ quantity: string }>(
    `SELECT COALESCE(sum(quantity), 0)::text AS quantity
       FROM stock_movements
      WHERE inventory_item_id = $1 AND occurred_at::date = $2::date
        AND source_type IN ('order', 'order_amendment')`,
    [biz.inventoryItemId, day],
  );
  return Number(rows[0].quantity);
}

async function netPaid(orderId: string): Promise<number> {
  const { rows } = await db.query<{ amount: string }>(
    "SELECT COALESCE(sum(amount), 0)::text AS amount FROM payments WHERE order_id = $1",
    [orderId],
  );
  return Number(rows[0].amount);
}

async function everyEntryBalances(): Promise<boolean> {
  const { rows } = await db.query<{ unbalanced: string }>(
    `SELECT count(*)::text AS unbalanced FROM (
       SELECT entry_id FROM journal_lines GROUP BY entry_id HAVING sum(debit) <> sum(credit)
     ) bad`,
  );
  return rows[0].unbalanced === "0";
}

describe("removing a closed order", () => {
  it("leaves no trace of the sale in the ledger, the stock ledger or the till", async () => {
    const stockBefore = await physicalStock();
    const valueBefore = await stockValue();
    const order = await sellOrder({
      lines: [{ menuItemId: biz.menuItemId, quantity: 2 }],
      method: "cash",
      soldOn: "2026-03-10",
      tip: 20_000,
    });

    // The sale is on the books for the day it happened.
    expect(await accountBalance("4310", "2026-03-10")).toBeLessThan(0);
    expect(await physicalStock()).toBe(stockBefore - 20);

    const result = await amend(order.id, { kind: "void", reason: "سفارش اشتباه ثبت شده بود" });
    expect(result.kind).toBe("void");
    expect(result.entryDate).toBe("2026-03-10");

    // Ledger: every account the sale touched is back where it was — and on the
    // sale's own date, so that day's reports change too.
    for (const code of ["1100", "4310", "2200", "2400", "5100", "1300"]) {
      expect([code, await accountBalance(code, "2026-03-10")]).toEqual([code, 0]);
      expect([code, await accountBalance(code)]).toEqual([code, 0]);
    }
    expect(await everyEntryBalances()).toBe(true);

    // Stock: the exact quantity and cost basis are back.
    expect(await physicalStock()).toBe(stockBefore);
    expect(await stockValue()).toBe(valueBefore);

    // Till: the payment nets to zero, and the order drops out of every
    // completed-order report by status.
    expect(await netPaid(order.id)).toBe(0);
    const { rows } = await db.query<{ status: string; voided_reason: string }>(
      "SELECT status, voided_reason FROM orders WHERE id = $1",
      [order.id],
    );
    expect(rows[0].status).toBe("voided");
    expect(rows[0].voided_reason).toBe("سفارش اشتباه ثبت شده بود");
  });

  it("clears the customer's receivable when the order was sold on credit", async () => {
    const order = await sellOrder({
      lines: [{ menuItemId: biz.menuItemId, quantity: 1 }],
      method: "credit",
      soldOn: "2026-03-11",
      customerId: biz.customerId,
    });
    expect(await accountBalance("1200")).toBe(order.total);

    await amend(order.id, { kind: "void", reason: "فاکتور اعتباری باطل شد" });
    expect(await accountBalance("1200")).toBe(0);

    const arService = await import("../src/lib/ar-service");
    const balances = await dbLib.withTenant(biz.id, () => arService.listCustomerBalances(biz.id));
    expect(balances).toEqual([]);
  });

  it("refuses an order that already has a customer return standing against it", async () => {
    const order = await sellOrder({
      lines: [{ menuItemId: biz.menuItemId, quantity: 1 }],
      method: "cash",
      soldOn: "2026-03-12",
    });
    await db.query(
      `INSERT INTO customer_returns (business_id, location_id, order_id, refund_method, refund_amount_rial, reason, idempotency_key)
       VALUES ($1, $2, $3, 'cash', 1000, 'تست', $4)`,
      [biz.id, biz.locationId, order.id, randomUUID()],
    );
    await expect(amend(order.id, { kind: "void", reason: "تلاش برای ابطال" })).rejects.toThrow(
      "order_has_returns",
    );
  });

  it("refuses an order that is not closed yet", async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO orders (location_id, order_number, type, status, subtotal, tax, total)
       VALUES ($1, $2, 'dine_in', 'open', 0, 0, 0) RETURNING id`,
      [biz.locationId, ++orderNumber],
    );
    await expect(amend(rows[0].id, { kind: "void", reason: "هنوز باز است" })).rejects.toThrow(
      "order_not_completed",
    );
  });

  it("refuses to touch a locked fiscal period instead of moving the correction into an open one", async () => {
    const order = await sellOrder({
      lines: [{ menuItemId: biz.menuItemId, quantity: 1 }],
      method: "cash",
      soldOn: "2026-03-13",
    });
    const { rows: year } = await db.query<{ id: string }>(
      "INSERT INTO fiscal_years (business_id, label, starts_on, ends_on) VALUES ($1, '1404', '2026-03-01', '2027-02-28') RETURNING id",
      [biz.id],
    );
    await db.query(
      `INSERT INTO fiscal_periods (business_id, fiscal_year_id, label, starts_on, ends_on, status)
       VALUES ($1, $2, '1404-12', '2026-03-01', '2026-03-31', 'locked')`,
      [biz.id, year[0].id],
    );
    await expect(amend(order.id, { kind: "void", reason: "ماه بسته است" })).rejects.toThrow(
      "fiscal_period_locked",
    );
    // …and nothing was half-applied.
    const { rows: after } = await db.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [
      order.id,
    ]);
    expect(after[0].status).toBe("completed");
    expect(await netPaid(order.id)).toBe(order.total);
  });
});

describe("editing a closed order", () => {
  it("re-posts revenue, tax, COGS, stock and the payment at the corrected amounts", async () => {
    const stockBefore = await physicalStock();
    const order = await sellOrder({
      lines: [{ menuItemId: biz.menuItemId, quantity: 3 }],
      method: "card",
      soldOn: "2026-04-05",
    });
    expect(await physicalStock()).toBe(stockBefore - 30);

    const result = await amend(order.id, {
      kind: "edit",
      reason: "یک فنجان سرو نشده بود",
      lines: [{ orderItemId: order.itemIds[0], quantity: 2 }],
    });

    expect(result.newTotal).toBe(220_000); // 2 × 100,000 + 10% tax
    expect(result.previousTotal).toBe(330_000);

    // One cup's worth of stock stayed sold; the third came back.
    expect(await physicalStock()).toBe(stockBefore - 20);
    // COGS on the sale's own date is exactly the two cups' cost.
    expect(await accountBalance("5100", "2026-04-05")).toBe(10_000);
    expect(await accountBalance("4310", "2026-04-05")).toBe(-200_000);
    expect(await accountBalance("2200", "2026-04-05")).toBe(-20_000);
    expect(await accountBalance("1120", "2026-04-05")).toBe(220_000);
    // Nothing landed on the day the correction was made.
    expect(await accountBalance("4310", new Date().toISOString().slice(0, 10))).toBe(0);
    expect(await everyEntryBalances()).toBe(true);

    expect(await netPaid(order.id)).toBe(220_000);
    const { rows } = await db.query<{ status: string; total: string; amended_at: string | null }>(
      "SELECT status, total::text, amended_at::text FROM orders WHERE id = $1",
      [order.id],
    );
    expect(rows[0].status).toBe("completed");
    expect(rows[0].total).toBe("220000");
    expect(rows[0].amended_at).not.toBeNull();
  });

  it("adds a line the till missed, consuming its ingredients and billing for it", async () => {
    const stockBefore = await physicalStock();
    const order = await sellOrder({
      lines: [{ menuItemId: biz.menuItemId, quantity: 1 }],
      method: "cash",
      soldOn: "2026-04-06",
    });

    await amend(order.id, {
      kind: "edit",
      reason: "لاته روی فاکتور ثبت نشده بود",
      lines: [
        { orderItemId: order.itemIds[0], quantity: 1 },
        { menuItemId: biz.secondMenuItemId, quantity: 1 },
      ],
    });

    // 10 g for the espresso + 20 g for the latte.
    expect(await physicalStock()).toBe(stockBefore - 30);
    expect(await accountBalance("5100", "2026-04-06")).toBe(15_000);
    expect(await accountBalance("4310", "2026-04-06")).toBe(-250_000);
    expect(await netPaid(order.id)).toBe(275_000);
    expect(await everyEntryBalances()).toBe(true);
  });

  it("re-settles through a different payment method when the till picked the wrong one", async () => {
    const order = await sellOrder({
      lines: [{ menuItemId: biz.menuItemId, quantity: 1 }],
      method: "cash",
      soldOn: "2026-04-07",
    });
    expect(await accountBalance("1100")).toBe(order.total);

    await amend(order.id, {
      kind: "edit",
      reason: "با کارت پرداخت شده بود نه نقدی",
      lines: [{ orderItemId: order.itemIds[0], quantity: 1 }],
      paymentMethod: "card",
    });

    expect(await accountBalance("1100")).toBe(0);
    expect(await accountBalance("1120")).toBe(order.total);
    const { rows } = await db.query<{ method: string; amount: string }>(
      "SELECT method::text AS method, sum(amount)::text AS amount FROM payments WHERE order_id = $1 GROUP BY method ORDER BY method",
      [order.id],
    );
    expect(rows).toEqual([
      { method: "card", amount: String(order.total) },
      { method: "cash", amount: "0" },
    ]);
  });

  it("can be amended twice, always unwinding the amendment that currently stands", async () => {
    const stockBefore = await physicalStock();
    const order = await sellOrder({
      lines: [{ menuItemId: biz.menuItemId, quantity: 3 }],
      method: "cash",
      soldOn: "2026-04-08",
    });

    await amend(order.id, {
      kind: "edit",
      reason: "اصلاح اول",
      lines: [{ orderItemId: order.itemIds[0], quantity: 2 }],
    });
    await amend(order.id, {
      kind: "edit",
      reason: "اصلاح دوم",
      lines: [{ orderItemId: order.itemIds[0], quantity: 1 }],
    });

    expect(await physicalStock()).toBe(stockBefore - 10);
    expect(await accountBalance("5100", "2026-04-08")).toBe(5_000);
    expect(await accountBalance("4310", "2026-04-08")).toBe(-100_000);
    expect(await accountBalance("1100", "2026-04-08")).toBe(110_000);
    expect(await netPaid(order.id)).toBe(110_000);
    expect(await everyEntryBalances()).toBe(true);

    // …and then removed outright, back to nothing.
    await amend(order.id, { kind: "void", reason: "در نهایت باطل شد" });
    expect(await physicalStock()).toBe(stockBefore);
    for (const code of ["1100", "4310", "2200", "5100", "1300"]) {
      expect([code, await accountBalance(code)]).toEqual([code, 0]);
    }
    expect(await netPaid(order.id)).toBe(0);

    const client = await dbLib.getPool().connect();
    try {
      const history = await amendmentService.listOrderAmendments(client, order.id);
      expect(history.map((entry) => entry.kind)).toEqual(["edit", "edit", "void"]);
      expect(history.map((entry) => entry.reason)).toEqual(["اصلاح اول", "اصلاح دوم", "در نهایت باطل شد"]);
    } finally {
      client.release();
    }
  });

  it("keeps a delivery order's fee on the corrected bill", async () => {
    const order = await sellOrder({
      lines: [{ menuItemId: biz.menuItemId, quantity: 2 }],
      method: "cash",
      soldOn: "2026-04-10",
      type: "delivery",
      deliveryFee: 30_000,
    });
    expect(order.total).toBe(250_000); // 200,000 + 10% tax + 30,000 delivery

    await amend(order.id, {
      kind: "edit",
      reason: "یک فنجان کم شود، هزینهٔ ارسال سر جای خود",
      lines: [{ orderItemId: order.itemIds[0], quantity: 1 }],
    });

    expect(await accountBalance("4330", "2026-04-10")).toBe(-130_000); // 100,000 item + 30,000 fee
    expect(await accountBalance("1100", "2026-04-10")).toBe(140_000);
    expect(await netPaid(order.id)).toBe(140_000);
  });

  it("corrects the stock ledger on the day of the sale, not the day of the correction", async () => {
    const order = await sellOrder({
      lines: [{ menuItemId: biz.menuItemId, quantity: 3 }],
      method: "cash",
      soldOn: "2026-05-04",
    });
    expect(await stockMovedOn("2026-05-04")).toBe(-30);

    await amend(order.id, {
      kind: "edit",
      reason: "یک فنجان سرو نشده بود",
      lines: [{ orderItemId: order.itemIds[0], quantity: 2 }],
    });

    // Reversal (+30) and replay (−20) are both dated on the sale's own day, so
    // the stock ledger agrees with the back-dated inventory/COGS entries rather
    // than showing the sale last week and its correction today.
    expect(await stockMovedOn("2026-05-04")).toBe(-20);
    expect(await stockMovedOn(new Date().toISOString().slice(0, 10))).toBe(0);
  });

  it("winds the central rollup back so the amended day is re-pushed", async () => {
    const order = await sellOrder({
      lines: [{ menuItemId: biz.menuItemId, quantity: 1 }],
      method: "cash",
      soldOn: "2026-05-05",
    });
    // A location that has already pushed everything up to today would otherwise
    // never re-send a day this old (RESEND_OVERLAP_DAYS = 2).
    await db.query(
      `INSERT INTO settings (business_id, location_id, key, value)
       VALUES ($1, NULL, 'rollup.sync_state', $2::jsonb)`,
      [biz.id, JSON.stringify({ lastAttemptAt: null, lastSuccessAt: null, lastSuccessDay: "2026-05-20", lastError: null })],
    );

    await amend(order.id, { kind: "void", reason: "باطل شد" });

    const { rows } = await db.query<{ day: string }>(
      `SELECT value->>'lastSuccessDay' AS day FROM settings
        WHERE business_id = $1 AND key = 'rollup.sync_state'`,
      [biz.id],
    );
    expect(rows[0].day).toBe("2026-05-05");
  });

  it("still refuses a line change made outside an amendment", async () => {
    const order = await sellOrder({
      lines: [{ menuItemId: biz.menuItemId, quantity: 1 }],
      method: "cash",
      soldOn: "2026-04-11",
    });
    // Migration 0014's guard is relaxed only for the length of an amendment's
    // own transaction; an ordinary write path still cannot restate a paid bill.
    await expect(
      db.query("UPDATE order_items SET quantity = 5 WHERE id = $1", [order.itemIds[0]]),
    ).rejects.toThrow("order_not_open");
  });

  it("records both sides of the correction in the audit trail", async () => {
    const order = await sellOrder({
      lines: [{ menuItemId: biz.menuItemId, quantity: 1 }],
      method: "cash",
      soldOn: "2026-04-09",
    });
    await amend(order.id, {
      kind: "edit",
      reason: "افزودن تخفیف",
      lines: [{ orderItemId: order.itemIds[0], quantity: 1 }],
      discount: { type: "percent", value: 50 },
    });

    const { rows } = await db.query<{ action: string; payload: { reason: string; newTotal: number } }>(
      "SELECT action, payload FROM audit_log WHERE entity = 'order' AND entity_id = $1",
      [order.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("order.amended");
    expect(rows[0].payload.reason).toBe("افزودن تخفیف");
    expect(rows[0].payload.newTotal).toBe(55_000);
    expect(await accountBalance("4310", "2026-04-09")).toBe(-50_000);
  });

  it("handles amending an order under weighted-average costing when stock was oversold", async () => {
    await db.query(`UPDATE settings SET value = '{"method":"weighted_average"}'::jsonb WHERE business_id = $1 AND key = 'inventory.costing'`, [biz.id]);

    // Initial stock is 1000g.
    // Order 1 sells 800g (200g left in stock).
    const order1 = await sellOrder({
      lines: [
        { menuItemId: biz.menuItemId, quantity: 40 },
        { menuItemId: biz.menuItemId, quantity: 40 },
      ], // 800g
      method: "cash",
      soldOn: "2026-04-12",
    });
    // Order 2 sells 500g (200g from stock + 300g shortage; stock is now -300g).
    const order2 = await sellOrder({
      lines: [{ menuItemId: biz.menuItemId, quantity: 50 }], // 500g
      method: "cash",
      soldOn: "2026-04-12",
    });
    // Order 3 sells 500g (all shortage; stock is now -800g).
    const order3 = await sellOrder({
      lines: [{ menuItemId: biz.menuItemId, quantity: 50 }], // 500g
      method: "cash",
      soldOn: "2026-04-12",
    });

    // Now amend Order 2:
    // Reversal adds back 500g (stock becomes -300g).
    // positiveQuantity is 200g, positiveValue is 100,000 Rial.
    const result = await amend(order2.id, {
      kind: "edit",
      reason: "اصلاح سفارش دوم",
      lines: [{ orderItemId: order2.itemIds[0], quantity: 40 }], // 400g
    });

    expect(result.newTotal).toBe(4_400_000);
  });
});
