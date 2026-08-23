/**
 * Phase 32 exit criteria, against a real database.
 *
 * `tenant-isolation.integration.test.ts` already proves the four new tables
 * carry RLS like every other tenant table, and the pure modules' own unit tests
 * cover the rules. What can only be proven here is the thing the feature is:
 *
 *   - a cashier closing a shift makes the coworker do the night's write-off,
 *     end to end, with real stock and a real ledger entry;
 *   - the quantity is read from the shelf at fire time, not from the job the
 *     owner saved weeks ago;
 *   - the same job fired twice produces one run, not two write-offs;
 *   - an over-cap action is HELD, not dropped and not forced — and approving it
 *     by hand runs the identical write;
 *   - "ask me first" writes nothing at all until a human says yes.
 *
 * No provider is involved anywhere in this file, which is the point: a coworker
 * job is deterministic, so this test can assert exact quantities.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let coworker: typeof import("../src/lib/ai-coworker-service");
let events: typeof import("../src/lib/ai-coworker-events");
let autopilot: typeof import("../src/lib/ai-autopilot-service");

const clock = { dateKey: "2026-08-23", hour: 23, weekday: 0 };

const shop = { businessId: "", locationId: "", userId: "", itemId: "" };

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_ai_coworker_${randomUUID().replaceAll("-", "")}`;
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
  coworker = await import("../src/lib/ai-coworker-service");
  events = await import("../src/lib/ai-coworker-events");
  autopilot = await import("../src/lib/ai-autopilot-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

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

/** A café with twelve loaves on the shelf, at 50,000 ﷼ each. */
async function seedBakery(onHand: string) {
  const business = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    ["Bakery", `bakery-${randomUUID().slice(0, 8)}`],
  );
  const businessId = business.rows[0].id;

  const location = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [businessId],
  );
  const locationId = location.rows[0].id;

  const user = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, password_hash)
     VALUES ($1, 'owner', 'مالک', $2, 'x') RETURNING id`,
    [businessId, `owner-${randomUUID().slice(0, 8)}@example.test`],
  );

  await db.query(
    `INSERT INTO settings (business_id, key, value) VALUES ($1, 'inventory.costing', '{"method":"fifo"}'::jsonb)`,
    [businessId],
  );
  await db.query(
    `INSERT INTO accounts (business_id, code, name, type)
     SELECT $1, code, name, type::account_type FROM (VALUES
       ('1300','موجودی کالا','asset'),('5150','ضایعات','expense')
     ) a(code, name, type)`,
    [businessId],
  );

  const item = await db.query<{ id: string }>(
    `INSERT INTO inventory_items (location_id, name, unit, avg_cost, carrying_value_rial)
     VALUES ($1, 'نان', 'عدد', 50000, ($2::numeric * 50000)::bigint) RETURNING id`,
    [locationId, onHand],
  );
  const itemId = item.rows[0].id;

  // `ai_assistant` is default-OFF, and the coworker tick is gated on it —
  // which is itself worth having a test notice, so it is granted explicitly
  // rather than assumed.
  await db.query(
    "INSERT INTO business_features (business_id, flag_key, enabled) VALUES ($1, 'ai_assistant', true)",
    [businessId],
  );

  await setStock(itemId, locationId, onHand);
  return { businessId, locationId, userId: user.rows[0].id, itemId };
}

/**
 * Puts `quantity` on the shelf the way the app does — a priced FIFO lot plus
 * the stock-ledger movement that on-hand is summed from. There is no quantity
 * column to set.
 */
async function setStock(itemId: string, locationId: string, quantity: string) {
  await db.query("DELETE FROM inventory_lots WHERE inventory_item_id = $1", [itemId]);
  await db.query("DELETE FROM stock_movements WHERE inventory_item_id = $1", [itemId]);
  await db.query(
    `UPDATE inventory_items SET carrying_value_rial = ($2::numeric * 50000)::bigint WHERE id = $1`,
    [itemId, quantity],
  );
  if (Number(quantity) === 0) return;
  await db.query(
    `INSERT INTO inventory_lots
       (location_id, inventory_item_id, remaining_qty, unit_cost, source_type,
        original_quantity, original_value_rial, remaining_value_rial)
     VALUES ($1, $2, $3::numeric, 50000, 'opening', $3::numeric,
             ($3::numeric * 50000)::bigint, ($3::numeric * 50000)::bigint)`,
    [locationId, itemId, quantity],
  );
  await db.query(
    `INSERT INTO stock_movements
       (location_id, inventory_item_id, type, quantity, unit_cost, cost_value_rial, source_type)
     VALUES ($1, $2, 'purchase', $3::numeric, 50000, ($3::numeric * 50000)::bigint, 'opening')`,
    [locationId, itemId, quantity],
  );
}

beforeEach(async () => {
  // In dependency order: inventory_events (and the postings that reference it)
  // are ON DELETE RESTRICT from businesses, so a bare truncate of businesses
  // fails once a run has actually written something.
  for (const table of [
    "ai_coworker_run_actions",
    "ai_coworker_runs",
    "ai_coworker_events",
    "ai_coworker_jobs",
    "ai_action_audit",
    "ai_autopilot_settings",
    "stock_movements",
    "inventory_lots",
    "inventory_negative_layers",
    "journal_lines",
    "journal_entries",
    "domain_events",
    "inventory_events",
    "businesses",
  ]) {
    await db.query(`DELETE FROM ${table}`);
  }
  Object.assign(shop, await seedBakery("12"));
});

/** The bread job, as an owner would set it up. */
async function createWasteJob(overrides: Record<string, unknown> = {}) {
  return dbLib.withTenant(shop.businessId, async () => {
    const created = await coworker.createCoworkerJob(
      shop.businessId,
      {
        templateKey: "shift_close_waste",
        title: "ضایعات نان پایان شب",
        locationId: null,
        triggerKind: "event",
        eventKind: "shift_close",
        scheduleHour: null,
        scheduleWeekday: null,
        params: { items: [{ inventoryItemId: shop.itemId, mode: "remaining", reason: "spoilage" }] },
        approvalMode: "ask",
        enabled: true,
        ...overrides,
      },
      shop.userId,
    );
    if (!created.ok) throw new Error(`job creation failed: ${created.errors.join(", ")}`);
    return created.job;
  });
}

async function enableWasteAutopilot(caps: { maxAmountRial?: number | null; maxItemsPerRun?: number } = {}) {
  return dbLib.withTenant(shop.businessId, () =>
    autopilot.setAutopilotCategory(shop.businessId, "waste", { enabled: true, ...caps }, shop.userId),
  );
}

async function closeAShift() {
  await dbLib.withTenant(shop.businessId, () =>
    events.recordCoworkerEvent({ businessId: shop.businessId, locationId: shop.locationId, kind: "shift_close" }),
  );
}

async function tick() {
  return dbLib.withTenant(shop.businessId, () => coworker.runCoworkerTick(shop.businessId, clock));
}

async function runs() {
  return dbLib.withTenant(shop.businessId, () => coworker.listCoworkerRuns(shop.businessId, { limit: 50 }));
}

async function onHand(): Promise<string> {
  const { rows } = await db.query<{ quantity: string }>(
    `SELECT trim_scale(COALESCE(sum(quantity), 0))::text AS quantity
       FROM stock_movements WHERE inventory_item_id = $1`,
    [shop.itemId],
  );
  return rows[0].quantity;
}

async function wasteExpenseRial(): Promise<number> {
  const { rows } = await db.query<{ total: string }>(
    `SELECT COALESCE(sum(jl.debit - jl.credit), 0)::text AS total
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
      WHERE a.business_id = $1 AND a.code = '5150'`,
    [shop.businessId],
  );
  return Number(rows[0].total);
}

describe("a shift closing sets the coworker going", () => {
  it("writes off the night's remaining bread, on the ledger, with no human in the loop", async () => {
    await enableWasteAutopilot({ maxAmountRial: 20_000_000 });
    await createWasteJob({ approvalMode: "auto" });

    await closeAShift();
    expect(await tick()).toBe(1);

    // 12 loaves × 50,000 ﷼ left the shelf and hit the waste account.
    expect(await onHand()).toBe("0");
    expect(await wasteExpenseRial()).toBe(600_000);

    const [run] = await runs();
    expect(run.status).toBe("applied");
    expect(run.triggerSource).toBe("event");
    expect(run.actions).toHaveLength(1);
    expect(run.actions[0].status).toBe("applied");

    // The write is in the assistant's own audit trail, tagged as the coworker's.
    const audit = await db.query<{ source: string; status: string; action_type: string }>(
      "SELECT source, status, action_type FROM ai_action_audit WHERE business_id = $1",
      [shop.businessId],
    );
    expect(audit.rows).toEqual([
      { source: "coworker", status: "applied", action_type: "inventory.waste.log" },
    ]);
  });

  it("follows the shelf, not the job — a busier night writes off less, with no edit", async () => {
    await enableWasteAutopilot({ maxAmountRial: 20_000_000 });
    await createWasteJob({ approvalMode: "auto" });

    // Same job, but only three loaves survived tonight.
    await setStock(shop.itemId, shop.locationId, "3");

    await closeAShift();
    await tick();

    expect(await onHand()).toBe("0");
    expect(await wasteExpenseRial()).toBe(150_000);
  });

  it("fires once per event however often the tick runs", async () => {
    await enableWasteAutopilot({ maxAmountRial: 20_000_000 });
    await createWasteJob({ approvalMode: "auto" });

    await closeAShift();
    expect(await tick()).toBe(1);
    // A second tick with no new event — and a third, as if two app instances
    // raced — must not write the same night off again.
    expect(await tick()).toBe(0);
    expect(await tick()).toBe(0);

    expect(await runs()).toHaveLength(1);
    expect(await wasteExpenseRial()).toBe(600_000);
  });

  it("ignores a shift at another branch when the job names one", async () => {
    const other = await db.query<{ id: string }>(
      "INSERT INTO locations (business_id, name) VALUES ($1, 'Second') RETURNING id",
      [shop.businessId],
    );
    await enableWasteAutopilot({ maxAmountRial: 20_000_000 });
    await createWasteJob({ approvalMode: "auto", locationId: shop.locationId });

    await dbLib.withTenant(shop.businessId, () =>
      events.recordCoworkerEvent({
        businessId: shop.businessId,
        locationId: other.rows[0].id,
        kind: "shift_close",
      }),
    );
    expect(await tick()).toBe(0);
    expect(await onHand()).toBe("12");
  });
});

describe("the approval boundary", () => {
  it("writes nothing while the owner has asked to be asked, then writes on approval", async () => {
    await enableWasteAutopilot({ maxAmountRial: 20_000_000 });
    await createWasteJob({ approvalMode: "ask" });

    await closeAShift();
    await tick();

    // Nothing moved: the run is a question, not a change.
    expect(await onHand()).toBe("12");
    expect(await wasteExpenseRial()).toBe(0);

    const [pending] = await runs();
    expect(pending.status).toBe("pending_approval");
    expect(pending.actions[0].status).toBe("pending");
    expect(pending.actions[0].heldReason).toBeTruthy();

    const decided = await dbLib.withTenant(shop.businessId, () =>
      coworker.decideCoworkerRun({
        businessId: shop.businessId,
        runId: pending.id,
        decision: "approve",
        actorUserId: shop.userId,
      }),
    );
    expect(decided.ok).toBe(true);
    expect(await onHand()).toBe("0");
    expect(await wasteExpenseRial()).toBe(600_000);
  });

  it("rejecting changes nothing and closes the run", async () => {
    await createWasteJob();
    await closeAShift();
    await tick();

    const [pending] = await runs();
    await dbLib.withTenant(shop.businessId, () =>
      coworker.decideCoworkerRun({
        businessId: shop.businessId,
        runId: pending.id,
        decision: "reject",
        actorUserId: shop.userId,
      }),
    );

    expect(await onHand()).toBe("12");
    const [after] = await runs();
    expect(after.status).toBe("rejected");
    expect(after.actions[0].status).toBe("rejected");
  });

  it("cannot be a way around the autopilot caps — an over-cap job is held, never forced", async () => {
    // The night's bread is worth 600,000 ﷼; the owner's waste cap is 100,000.
    await enableWasteAutopilot({ maxAmountRial: 100_000 });
    await createWasteJob({ approvalMode: "auto" });

    await closeAShift();
    await tick();

    expect(await onHand()).toBe("12");
    const [run] = await runs();
    expect(run.status).toBe("pending_approval");
    expect(run.actions[0].heldReason).toContain("سقف");

    // Held is not dropped: the identical action still applies by hand.
    await dbLib.withTenant(shop.businessId, () =>
      coworker.decideCoworkerRun({
        businessId: shop.businessId,
        runId: run.id,
        decision: "approve",
        actorUserId: shop.userId,
      }),
    );
    expect(await onHand()).toBe("0");
  });

  it("refuses to write unattended when the category was never switched on", async () => {
    await createWasteJob({ approvalMode: "auto" });
    await closeAShift();
    await tick();

    expect(await onHand()).toBe("12");
    const [run] = await runs();
    expect(run.status).toBe("pending_approval");
  });
});

describe("a job that has nothing to do", () => {
  it("records a skipped run rather than a failure, and says why", async () => {
    await enableWasteAutopilot({ maxAmountRial: 20_000_000 });
    await createWasteJob({ approvalMode: "auto" });
    await setStock(shop.itemId, shop.locationId, "0");

    await closeAShift();
    await tick();

    const [run] = await runs();
    expect(run.status).toBe("skipped");
    expect(run.actions).toHaveLength(0);
    expect(run.summary.length).toBeGreaterThan(0);
    expect(await wasteExpenseRial()).toBe(0);
  });
});

describe("the accounting review", () => {
  it("finds a real unbalanced entry and reports it without changing anything", async () => {
    const review = await import("../src/lib/accounting-review-service");

    const clean = await dbLib.withTenant(shop.businessId, () => review.runAccountingReview(shop.businessId));
    const before = clean.findings.find((finding) => finding.code === "unbalanced_entry");
    expect(before).toBeUndefined();

    // Every rule's query actually ran. A check that degrades to "found
    // nothing" is indistinguishable from clean books, so a schema change that
    // breaks one must fail here rather than quietly shrink the review.
    expect(clean.unavailableChecks).toEqual([]);

    // A one-legged entry: exactly what postExactJournalEntry cannot produce,
    // and exactly what the review exists to catch if something ever does.
    const entry = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, location_id, entry_date, memo, source_type)
       VALUES ($1, $2, current_date, 'سند ناقص', 'manual') RETURNING id`,
      [shop.businessId, shop.locationId],
    );
    const account = await db.query<{ id: string }>(
      "SELECT id FROM accounts WHERE business_id = $1 AND code = '1300'",
      [shop.businessId],
    );
    await db.query("INSERT INTO journal_lines (entry_id, account_id, debit) VALUES ($1, $2, 250000)", [
      entry.rows[0].id,
      account.rows[0].id,
    ]);

    const after = await dbLib.withTenant(shop.businessId, () => review.runAccountingReview(shop.businessId));
    const finding = after.findings.find((row) => row.code === "unbalanced_entry");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("high");
    expect(finding?.amountRial).toBe(250_000);
    expect(finding?.suggestion.length).toBeGreaterThan(0);

    // Reporting is all it does — the entry is untouched.
    const lines = await db.query("SELECT * FROM journal_lines WHERE entry_id = $1", [entry.rows[0].id]);
    expect(lines.rows).toHaveLength(1);
  });
});
