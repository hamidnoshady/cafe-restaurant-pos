/**
 * Back-dated orders: recording a sale that already happened, and proving every
 * ledger it touches agrees about *when*.
 *
 * The order row is the easy half. What these tests are actually for is the
 * three places a back-dated sale could quietly land on today instead:
 * `journal_entries.entry_date`, `stock_movements.occurred_at`, and the branch's
 * business-day bucketing when its trading day does not start at midnight. Plus
 * the one case that must be refused outright — a month that has been closed.
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
let service: typeof import("../src/lib/backdated-order-service");
let pure: typeof import("../src/lib/backdated-orders");

const biz = { id: "", locationId: "", menuItemId: "", inventoryItemId: "", customerId: "", userId: "" };

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_backdated_${randomUUID().replaceAll("-", "")}`;
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
  service = await import("../src/lib/backdated-order-service");
  pure = await import("../src/lib/backdated-orders");
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
  ["2200", "VAT Payable", "liability"],
  ["2400", "Tips Payable", "liability"],
  ["4310", "Dine-in revenue", "revenue"],
  ["4320", "Takeaway revenue", "revenue"],
  ["4330", "Delivery revenue", "revenue"],
  ["5100", "COGS", "expense"],
  ["5650", "Platform commission", "expense"],
];

beforeEach(async () => {
  const { rows: business } = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Backdate Co', $1) RETURNING id",
    [`backdate-${randomUUID().slice(0, 8)}`],
  );
  biz.id = business[0].id;
  const { rows: location } = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name, timezone) VALUES ($1, 'Main', 'Asia/Tehran') RETURNING id",
    [biz.id],
  );
  biz.locationId = location[0].id;
  const { rows: user } = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, email, password_hash, full_name, role)
     VALUES ($1, $2, 'x', 'مدیر', 'manager') RETURNING id`,
    [biz.id, `manager-${randomUUID().slice(0, 8)}@example.com`],
  );
  biz.userId = user[0].id;
  await db.query(
    `INSERT INTO accounts (business_id, code, name, type)
     SELECT $1, code, name, type::account_type FROM UNNEST($2::text[], $3::text[], $4::text[]) AS a(code, name, type)`,
    [biz.id, ACCOUNTS.map((a) => a[0]), ACCOUNTS.map((a) => a[1]), ACCOUNTS.map((a) => a[2])],
  );
  await db.query(
    `INSERT INTO settings (business_id, key, value) VALUES ($1, 'inventory.costing', '{"method":"fifo"}'::jsonb)`,
    [biz.id],
  );

  const { rows: customer } = await db.query<{ id: string }>(
    "INSERT INTO parties (business_id, name) VALUES ($1, 'مشتری') RETURNING id",
    [biz.id],
  );
  biz.customerId = customer[0].id;

  const { rows: category } = await db.query<{ id: string }>(
    "INSERT INTO menu_categories (location_id, name, tax_rate) VALUES ($1, 'نوشیدنی', 10) RETURNING id",
    [biz.locationId],
  );
  const { rows: menuItems } = await db.query<{ id: string }>(
    `INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1, $2, 'اسپرسو', 100000) RETURNING id`,
    [biz.locationId, category[0].id],
  );
  biz.menuItemId = menuItems[0].id;

  const { rows: inventoryItem } = await db.query<{ id: string }>(
    `INSERT INTO inventory_items (location_id, name, unit, avg_cost, carrying_value_rial)
     VALUES ($1, 'دانه قهوه', 'gram', 0, 0) RETURNING id`,
    [biz.locationId],
  );
  biz.inventoryItemId = inventoryItem[0].id;
  await db.query(
    `INSERT INTO menu_item_ingredients (menu_item_id, inventory_item_id, quantity) VALUES ($1, $2, 10)`,
    [biz.menuItemId, biz.inventoryItemId],
  );

  // 1000 g at 500 Rial/g, as a FIFO lot with an exact cost basis.
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

async function record(input: Partial<Parameters<typeof pure.validateBackdatedOrder>[0]> = {}) {
  const validated = pure.validateBackdatedOrder({
    occurredAt: new Date(Date.now() - 6 * 86_400_000).toISOString(),
    type: "takeaway",
    reason: "شب قطعی برق، فاکتورها دستی نوشته شد",
    lines: [{ menuItemId: biz.menuItemId, quantity: 2 }],
    payments: [{ method: "cash" }],
    ...input,
  });
  if (!validated.ok) throw new Error(`fixture invalid: ${validated.error}`);

  const client = await dbLib.getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await service.recordBackdatedOrder(client, {
      businessId: biz.id,
      locationId: biz.locationId,
      actorId: biz.userId,
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

describe("recordBackdatedOrder", () => {
  it("dates the order, its stock movements and its journal entries when the sale happened", async () => {
    const occurredAt = "2026-07-02T09:15:00.000Z"; // 12:45 Tehran, 11 Tir
    const result = await record({ occurredAt });
    expect(result.entryDate).toBe("2026-07-02");

    const { rows: orders } = await db.query<{ opened_at: Date; closed_at: Date; status: string; total: string }>(
      "SELECT opened_at, closed_at, status, total FROM orders WHERE id = $1",
      [result.orderId],
    );
    expect(orders[0].status).toBe("completed");
    expect(orders[0].opened_at.toISOString()).toBe(occurredAt);
    expect(orders[0].closed_at.toISOString()).toBe(occurredAt);
    // 2 × 100,000 with a 10% category tax rate.
    expect(Number(orders[0].total)).toBe(220000);

    const { rows: entries } = await db.query<{ entry_date: string; posting_kind: string | null }>(
      `SELECT entry_date::text AS entry_date, posting_kind FROM journal_entries
        WHERE business_id = $1 AND source_id = $2 ORDER BY posting_kind`,
      [biz.id, result.orderId],
    );
    expect(entries.length).toBe(2);
    expect(entries.every((entry) => entry.entry_date === "2026-07-02")).toBe(true);

    const { rows: movements } = await db.query<{ occurred_at: Date; type: string }>(
      `SELECT occurred_at, type FROM stock_movements WHERE source_id = $1`,
      [result.orderId],
    );
    expect(movements.length).toBe(1);
    expect(movements[0].type).toBe("sale");
    expect(movements[0].occurred_at.toISOString()).toBe(occurredAt);

    const { rows: payments } = await db.query<{ received_at: Date; amount: string; method: string }>(
      "SELECT received_at, amount, method FROM payments WHERE order_id = $1",
      [result.orderId],
    );
    expect(payments.length).toBe(1);
    expect(payments[0].method).toBe("cash");
    expect(Number(payments[0].amount)).toBe(220000);
    expect(payments[0].received_at.toISOString()).toBe(occurredAt);
  });

  it("records who entered it, why, and when they actually did — the one honest clock", async () => {
    const before = new Date();
    const result = await record({ reason: "فروش پیش از نصب سیستم" });

    const { rows } = await db.query<{
      reason: string;
      created_by: string;
      created_at: Date;
      occurred_at: Date;
      entry_date: string;
    }>(
      `SELECT reason, created_by, created_at, occurred_at, entry_date::text AS entry_date
         FROM backdated_orders WHERE order_id = $1`,
      [result.orderId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].reason).toBe("فروش پیش از نصب سیستم");
    expect(rows[0].created_by).toBe(biz.userId);
    // Typed in now, even though the sale it describes is six days old.
    expect(rows[0].created_at.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(rows[0].occurred_at.getTime()).toBeLessThan(before.getTime() - 5 * 86_400_000);

    const { rows: audit } = await db.query<{ action: string }>(
      "SELECT action FROM audit_log WHERE business_id = $1 AND entity_id = $2",
      [biz.id, result.orderId],
    );
    expect(audit.map((row) => row.action)).toContain("order.backdated");
  });

  it("buckets an after-midnight sale into the previous trading day for a branch whose day starts at 18:00", async () => {
    await db.query("UPDATE locations SET business_day_start_minutes = $2 WHERE id = $1", [
      biz.locationId,
      18 * 60,
    ]);
    // 01:00 Tehran on 3 July is still 2 July's service for an 18:00 start.
    const result = await record({ occurredAt: "2026-07-02T21:30:00.000Z" });
    expect(result.entryDate).toBe("2026-07-02");

    const { rows: entries } = await db.query<{ entry_date: string }>(
      `SELECT entry_date::text AS entry_date FROM journal_entries WHERE source_id = $1 LIMIT 1`,
      [result.orderId],
    );
    expect(entries[0].entry_date).toBe("2026-07-02");

    // And the SQL side agrees with the TypeScript that picked it.
    const { rows: bucketed } = await db.query<{ business_date: string }>(
      `SELECT app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes)::text AS business_date
         FROM orders o JOIN locations l ON l.id = o.location_id WHERE o.id = $1`,
      [result.orderId],
    );
    expect(bucketed[0].business_date).toBe(result.entryDate);
  });

  it("refuses a sale into a locked fiscal period rather than moving it to today", async () => {
    const { rows: year } = await db.query<{ id: string }>(
      `INSERT INTO fiscal_years (business_id, label, starts_on, ends_on)
       VALUES ($1, '1405', '2026-03-21', '2027-03-20') RETURNING id`,
      [biz.id],
    );
    await db.query(
      `INSERT INTO fiscal_periods (business_id, fiscal_year_id, label, starts_on, ends_on, status)
       VALUES ($1, $2, 'تیر', '2026-06-22', '2026-07-22', 'locked')`,
      [biz.id, year[0].id],
    );

    await expect(record({ occurredAt: "2026-07-02T09:15:00.000Z" })).rejects.toThrow(/fiscal_period_locked/);

    // Nothing leaked out of the rolled-back transaction.
    const { rows: orders } = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM orders WHERE location_id = $1",
      [biz.locationId],
    );
    expect(Number(orders[0].count)).toBe(0);
  });

  it("consumes stock exactly once, at the lot's own cost", async () => {
    const result = await record();
    const { rows: lots } = await db.query<{ value: string; qty: string }>(
      `SELECT COALESCE(sum(remaining_value_rial), 0)::text AS value,
              COALESCE(sum(remaining_qty), 0)::text AS qty
         FROM inventory_lots WHERE inventory_item_id = $1`,
      [biz.inventoryItemId],
    );
    // 2 espressos × 10 g × 500 Rial = 10,000 off a 500,000 lot value.
    expect(Number(lots[0].qty)).toBe(980);
    expect(Number(lots[0].value)).toBe(490000);

    const { rows: cogs } = await db.query<{ debit: string }>(
      `SELECT jl.debit FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         JOIN accounts a ON a.id = jl.account_id
        WHERE je.source_id = $1 AND a.code = '5100'`,
      [result.orderId],
    );
    expect(Number(cogs[0].debit)).toBe(10000);
  });

  it("splits one back-dated bill across several payment ways", async () => {
    const result = await record({
      payments: [
        { method: "cash", amount: 100000 },
        { method: "card", amount: 120000 },
      ],
    });
    const { rows: payments } = await db.query<{ method: string; amount: string; settlement_seq: number }>(
      "SELECT method, amount, settlement_seq FROM payments WHERE order_id = $1 ORDER BY settlement_seq",
      [result.orderId],
    );
    expect(payments.map((row) => [row.method, Number(row.amount), row.settlement_seq])).toEqual([
      ["cash", 100000, 1],
      ["card", 120000, 2],
    ]);
  });

  it("takes no table, even for a dine-in sale", async () => {
    const result = await record({ type: "dine_in" });
    const { rows } = await db.query<{ type: string; table_id: string | null; table_session_id: string | null }>(
      "SELECT type, table_id, table_session_id FROM orders WHERE id = $1",
      [result.orderId],
    );
    expect(rows[0].type).toBe("dine_in");
    expect(rows[0].table_id).toBeNull();
    expect(rows[0].table_session_id).toBeNull();
  });

  it("lists what was entered late, newest sale first", async () => {
    const older = await record({ occurredAt: "2026-07-01T09:00:00.000Z" });
    const newer = await record({ occurredAt: "2026-07-05T09:00:00.000Z" });

    const client = await dbLib.getPool().connect();
    try {
      const entries = await service.listBackdatedOrders(client, biz.locationId);
      expect(entries.map((entry) => entry.orderId)).toEqual([newer.orderId, older.orderId]);
      expect(entries[0].entryDate).toBe("2026-07-05");
      expect(entries[0].recordedByName).toBe("مدیر");
    } finally {
      client.release();
    }
  });
});
