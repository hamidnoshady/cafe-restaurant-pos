/**
 * Leads, conversion, and configurable pipelines.
 *
 * The properties under test are the ones that cost real money when they break:
 *
 * 1. **Conversion deduplicates.** A lead converted without checking creates a
 *    second record for somebody who is already a customer, and duplicates are
 *    far cheaper to prevent than to merge.
 * 2. **Ambiguity stops conversion.** Two candidates is not a situation to
 *    resolve by picking; it is a question to ask.
 * 3. **Conversion is atomic and idempotent.** A double-clicked button must
 *    produce one customer, not two.
 * 4. **Winning a deal posts nothing.** A pipeline is a forecast. If dragging a
 *    card could write a journal line, anyone with CRM access could fabricate
 *    revenue, and the real invoice would then double-count it.
 * 5. **The pipeline migration is lossless.** Every pre-0157 deal still has a
 *    stage, and the legacy text column still agrees with it.
 * 6. **Stage history records the path**, because "where do deals stall" is
 *    unanswerable from a current-state column.
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
let leads: typeof import("../src/lib/crm-lead-service");
let pipelines: typeof import("../src/lib/crm-pipeline-service");

const biz = { id: "", locationId: "" };
const actor = { name: "مدیر فروش" };

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
  databaseName = `pos_leads_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  leads = await import("../src/lib/crm-lead-service");
  pipelines = await import("../src/lib/crm-pipeline-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const business = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, industry)
     VALUES ('فروش تست', $1, 'food_service') RETURNING id`,
    [`leads-${randomUUID().slice(0, 8)}`],
  );
  biz.id = business.rows[0].id;
  const location = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'شعبهٔ اصلی') RETURNING id`,
    [biz.id],
  );
  biz.locationId = location.rows[0].id;
}, 180_000);

afterAll(async () => {
  await db?.end();
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  await db.query(`DELETE FROM crm_deal_stage_history WHERE business_id = $1`, [biz.id]);
  await db.query(`DELETE FROM crm_deals WHERE business_id = $1`, [biz.id]);
  await db.query(`DELETE FROM crm_leads WHERE business_id = $1`, [biz.id]);
  await db.query(`DELETE FROM parties WHERE business_id = $1`, [biz.id]);
});

async function makeCustomer(name: string, phone?: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, roles, phone, phone_e164)
     VALUES ($1, $2, ARRAY['customer']::text[], $3, $3) RETURNING id`,
    [biz.id, name, phone ?? null],
  );
  return rows[0].id;
}

describe("the pipeline migration", () => {
  it("gave every business a default pipeline with a full set of stages", async () => {
    // `defaultPipeline` is the entry point precisely because it self-heals:
    // migration 0157 seeds businesses that existed when it ran, and this one
    // was created afterwards by a provisioning path that does not know about
    // pipelines. A business with no pipeline cannot open the deals board at
    // all, so the read path creates what it needs rather than trusting three
    // separate provisioning functions to remember.
    const def = await pipelines.defaultPipeline(biz.id);
    expect(def).not.toBeNull();
    // An open stage to create deals in and a won stage to close them in are
    // both structurally required — without either, the board cannot function.
    expect(def!.stages.some((stage) => stage.outcome === "open")).toBe(true);
    expect(def!.stages.some((stage) => stage.outcome === "won")).toBe(true);
    expect(def!.stages.some((stage) => stage.outcome === "lost")).toBe(true);

    // Every legacy stage string has a row, which is what makes the upgrade
    // lossless for deals written before 0157.
    const legacyKeys = def!.stages.map((stage) => stage.legacyKey).filter(Boolean).sort();
    expect(legacyKeys).toEqual(
      ["lead", "lost", "negotiation", "proposal", "qualified", "won"].sort(),
    );

    // And it is now visible to a plain list read, exactly once — a second call
    // must not seed a second pipeline.
    await pipelines.defaultPipeline(biz.id);
    const list = await pipelines.listPipelines(biz.id);
    expect(list).toHaveLength(1);
    expect(list[0].stages).toHaveLength(6);
  });

  it("seeds one pipeline even when two requests race for it", async () => {
    // Two people opening the deals board at the same moment on a business that
    // has never had one. ON CONFLICT DO NOTHING is what makes the loser read
    // the winner's row instead of creating a duplicate.
    const fresh = await db.query<{ id: string }>(
      `INSERT INTO businesses (name, slug, industry)
       VALUES ('همزمان', $1, 'food_service') RETURNING id`,
      [`race-${randomUUID().slice(0, 8)}`],
    );
    const id = fresh.rows[0].id;

    await Promise.all([
      pipelines.defaultPipeline(id),
      pipelines.defaultPipeline(id),
      pipelines.defaultPipeline(id),
    ]);

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM crm_pipelines WHERE business_id = $1`,
      [id],
    );
    expect(Number(rows[0].count)).toBe(1);

    const { rows: stages } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM crm_pipeline_stages WHERE business_id = $1`,
      [id],
    );
    expect(Number(stages[0].count)).toBe(6);
  });

  it("leaves no deal without a stage, including one written the old way", async () => {
    const customer = await makeCustomer("مشتری قدیمی");
    // A deal inserted exactly as pre-0157 code would have: a stage string and
    // nothing else.
    await db.query(
      `INSERT INTO crm_deals (business_id, customer_id, title, stage, value_rial)
       VALUES ($1, $2, 'معاملهٔ قدیمی', 'proposal', 5000000)`,
      [biz.id, customer],
    );

    // The service's own backfill path is the migration's; re-running it here
    // is not the point. The point is that the *shape* holds: a deal with a
    // legacy stage string can always be resolved to a stage row.
    const def = await pipelines.defaultPipeline(biz.id);
    const target = def!.stages.find((stage) => stage.legacyKey === "proposal");
    expect(target).toBeDefined();

    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM crm_deals WHERE business_id = $1 AND stage = 'proposal'`,
      [biz.id],
    );
    const moved = await pipelines.moveDealToStage(biz.id, rows[0].id, target!.id, actor);
    expect(moved.ok).toBe(true);
  });
});

describe("stage moves", () => {
  async function seedDeal(): Promise<{ dealId: string; stages: typeof stagesType }> {
    const customer = await makeCustomer("خریدار");
    const def = await pipelines.defaultPipeline(biz.id);
    const first = def!.stages.find((stage) => stage.legacyKey === "lead")!;
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO crm_deals
         (business_id, customer_id, title, stage, stage_id, pipeline_id, value_rial, stage_entered_at)
       VALUES ($1, $2, 'معاملهٔ آزمایشی', 'lead', $3, $4, 10000000, now()) RETURNING id`,
      [biz.id, customer, first.id, def!.id],
    );
    return { dealId: rows[0].id, stages: def!.stages };
  }
  let stagesType: Awaited<ReturnType<typeof pipelines.listPipelines>>[number]["stages"];

  it("records the path, not just the destination", async () => {
    const { dealId, stages } = await seedDeal();
    const qualified = stages.find((stage) => stage.legacyKey === "qualified")!;
    const proposal = stages.find((stage) => stage.legacyKey === "proposal")!;

    await pipelines.moveDealToStage(biz.id, dealId, qualified.id, actor);
    await pipelines.moveDealToStage(biz.id, dealId, proposal.id, actor, { note: "پیشنهاد ارسال شد" });

    const history = await pipelines.dealStageHistory(biz.id, dealId);
    // Oldest first, so it reads as a story.
    const path = history.map((entry) => entry.toStageName);
    expect(path).toEqual([qualified.name, proposal.name]);
    expect(history[1].fromStageName).toBe(qualified.name);
    expect(history[1].note).toBe("پیشنهاد ارسال شد");
    expect(history[1].changedBy).toBe(actor.name);
    // Dwell time on the stage just left is recorded, which is what makes a
    // velocity report a SUM rather than a window function over every row.
    expect(history[1].secondsInFromStage).not.toBeNull();
  });

  it("does not write a history row when the deal is already in that stage", async () => {
    // A board that re-saves on render would otherwise bury every real
    // transition under noise.
    const { dealId, stages } = await seedDeal();
    const qualified = stages.find((stage) => stage.legacyKey === "qualified")!;

    await pipelines.moveDealToStage(biz.id, dealId, qualified.id, actor);
    await pipelines.moveDealToStage(biz.id, dealId, qualified.id, actor);
    await pipelines.moveDealToStage(biz.id, dealId, qualified.id, actor);

    const history = await pipelines.dealStageHistory(biz.id, dealId);
    expect(history).toHaveLength(1);
  });

  it("keeps the legacy stage column in step, so old queries still work", async () => {
    const { dealId, stages } = await seedDeal();
    const won = stages.find((stage) => stage.outcome === "won")!;
    await pipelines.moveDealToStage(biz.id, dealId, won.id, actor, { wonReason: "قیمت مناسب" });

    const { rows } = await db.query<{ stage: string; closed_at: string | null }>(
      `SELECT stage, closed_at FROM crm_deals WHERE id = $1`,
      [dealId],
    );
    expect(rows[0].stage).toBe("won");
    // Reaching a terminal stage *is* closing; leaving that to each call site is
    // how half the rows end up terminal with no close date.
    expect(rows[0].closed_at).not.toBeNull();
  });

  it("winning a deal posts absolutely nothing to the ledger", async () => {
    // The property an accountant would ask about, and the reason the pipeline
    // has no journal linkage by design.
    const before = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM journal_lines`,
    );
    const beforeEntries = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM journal_entries WHERE business_id = $1`,
      [biz.id],
    );

    const { dealId, stages } = await seedDeal();
    const won = stages.find((stage) => stage.outcome === "won")!;
    await pipelines.moveDealToStage(biz.id, dealId, won.id, actor);

    const after = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM journal_lines`,
    );
    const afterEntries = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM journal_entries WHERE business_id = $1`,
      [biz.id],
    );

    expect(after.rows[0].count).toBe(before.rows[0].count);
    expect(afterEntries.rows[0].count).toBe(beforeEntries.rows[0].count);

    // No order or invoice was conjured either.
    const orders = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM orders WHERE location_id = $1`,
      [biz.locationId],
    );
    expect(Number(orders.rows[0].count)).toBe(0);
  });
});

describe("pipeline configuration", () => {
  it("refuses to delete a stage that still holds deals", async () => {
    // Deleting it would leave those deals off every board and out of every
    // forecast, discoverable only in SQL.
    const customer = await makeCustomer("مشتری");
    const def = await pipelines.defaultPipeline(biz.id);
    const proposal = def!.stages.find((stage) => stage.legacyKey === "proposal")!;
    await db.query(
      `INSERT INTO crm_deals (business_id, customer_id, title, stage, stage_id, pipeline_id)
       VALUES ($1, $2, 'معامله', 'proposal', $3, $4)`,
      [biz.id, customer, proposal.id, def!.id],
    );

    const remaining = def!.stages
      .filter((stage) => stage.id !== proposal.id)
      .map((stage) => ({ id: stage.id, name: stage.name, outcome: stage.outcome }));

    const result = await pipelines.savePipelineStages(biz.id, def!.id, remaining, actor);
    expect(result.error).toBe("stage_in_use");

    // And nothing was destroyed on the way to finding that out.
    const after = await pipelines.defaultPipeline(biz.id);
    expect(after!.stages.some((stage) => stage.id === proposal.id)).toBe(true);
  });

  it("refuses a pipeline with no open stage or no won stage", async () => {
    const def = await pipelines.defaultPipeline(biz.id);
    const wonOnly = def!.stages
      .filter((stage) => stage.outcome === "won")
      .map((stage) => ({ id: stage.id, name: stage.name, outcome: stage.outcome }));
    expect((await pipelines.savePipelineStages(biz.id, def!.id, wonOnly, actor)).error).toBe(
      "open_stage_required",
    );

    const openOnly = def!.stages
      .filter((stage) => stage.outcome === "open")
      .map((stage) => ({ id: stage.id, name: stage.name, outcome: stage.outcome }));
    expect((await pipelines.savePipelineStages(biz.id, def!.id, openOnly, actor)).error).toBe(
      "won_stage_required",
    );
  });

  it("adds a business's own stage without disturbing the seeded ones", async () => {
    const def = await pipelines.defaultPipeline(biz.id);
    const next = [
      ...def!.stages.map((stage) => ({
        id: stage.id,
        name: stage.name,
        outcome: stage.outcome,
        displayOrder: stage.displayOrder,
      })),
      { name: "بازدید از محل", outcome: "open" as const, displayOrder: 25 },
    ];

    const result = await pipelines.savePipelineStages(biz.id, def!.id, next, actor);
    expect(result.error).toBeUndefined();
    const names = result.pipeline!.stages.map((stage) => stage.name);
    expect(names).toContain("بازدید از محل");
    expect(names).toContain(def!.stages[0].name);
  });
});

describe("lead conversion", () => {
  it("links to the existing customer instead of creating a duplicate", async () => {
    const existing = await makeCustomer("رضا احمدی", "+989121230001");
    const lead = await leads.saveLead(
      biz.id,
      { name: "رضا احمدی", phone: "0912 123 0001" },
      actor,
    );

    // One candidate is reported rather than silently used: the person
    // converting should see who they are about to attach this to.
    const blocked = await leads.convertLead(biz.id, lead!.id, {}, actor);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok && blocked.error === "duplicates_found") {
      expect(blocked.duplicates.map((duplicate) => duplicate.partyId)).toEqual([existing]);
    } else {
      throw new Error("expected duplicates_found");
    }

    const linked = await leads.convertLead(biz.id, lead!.id, { partyId: existing }, actor);
    expect(linked).toMatchObject({ ok: true, partyId: existing, linkedExisting: true });

    // Exactly one customer, still.
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM parties WHERE business_id = $1`,
      [biz.id],
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it("refuses to choose when two customers match", async () => {
    await makeCustomer("خانواده الف", "+989121230002");
    await makeCustomer("خانواده ب", "+989121230002");
    const lead = await leads.saveLead(biz.id, { name: "تماس‌گیرنده", phone: "+989121230002" }, actor);

    // acknowledgeDuplicates deliberately does NOT force a choice here: it means
    // "create a new record anyway", not "pick one of these for me".
    const result = await leads.convertLead(biz.id, lead!.id, {}, actor);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error === "duplicates_found") {
      expect(result.duplicates).toHaveLength(2);
    } else {
      throw new Error("expected duplicates_found");
    }

    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM crm_leads WHERE id = $1`,
      [lead!.id],
    );
    expect(rows[0].status).not.toBe("converted");
  });

  it("creates a customer through the canonical service, searchable by phone", async () => {
    const lead = await leads.saveLead(
      biz.id,
      { name: "مشتری تازه", phone: "09121230003", email: "new@example.test", source: "instagram" },
      actor,
    );
    const result = await leads.convertLead(biz.id, lead!.id, {}, actor);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { rows } = await db.query<{
      name: string;
      phone_e164: string | null;
      acquisition_source: string | null;
      sms_consent: boolean;
      marketing_consent: boolean;
    }>(
      `SELECT name, phone_e164, acquisition_source, sms_consent, marketing_consent
         FROM parties WHERE id = $1`,
      [result.partyId],
    );
    expect(rows[0].name).toBe("مشتری تازه");
    // Normalised by the canonical service — writing the INSERT by hand here is
    // how a record ends up unsearchable by phone.
    expect(rows[0].phone_e164).toBe("+989121230003");
    // First-touch attribution survives conversion.
    expect(rows[0].acquisition_source).toBe("instagram");
    // An enquiry is not permission to market.
    expect(rows[0].sms_consent).toBe(false);
    expect(rows[0].marketing_consent).toBe(false);
  });

  it("is idempotent: converting twice produces one customer", async () => {
    const lead = await leads.saveLead(biz.id, { name: "دوبار", phone: "09121230004" }, actor);
    const first = await leads.convertLead(biz.id, lead!.id, {}, actor);
    const second = await leads.convertLead(biz.id, lead!.id, {}, actor);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe("already_converted");

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM parties WHERE business_id = $1`,
      [biz.id],
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it("survives a double-clicked convert button", async () => {
    // The row lock is what makes this safe; without it the two calls race past
    // the status check and both create a customer.
    const lead = await leads.saveLead(biz.id, { name: "همزمان", phone: "09121230005" }, actor);
    const [a, b] = await Promise.all([
      leads.convertLead(biz.id, lead!.id, {}, actor),
      leads.convertLead(biz.id, lead!.id, {}, actor),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM parties WHERE business_id = $1`,
      [biz.id],
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it("opens a deal in the first open stage when asked, with its history started", async () => {
    const lead = await leads.saveLead(biz.id, { name: "با معامله", phone: "09121230006" }, actor);
    const result = await leads.convertLead(
      biz.id,
      lead!.id,
      { createDeal: true, dealTitle: "سفارش عمده", dealValueRial: 50_000_000 },
      actor,
    );
    expect(result.ok).toBe(true);
    if (!result.ok || !result.dealId) throw new Error("expected a deal");

    const { rows } = await db.query<{ title: string; value_rial: string; stage: string }>(
      `SELECT title, value_rial, stage FROM crm_deals WHERE id = $1`,
      [result.dealId],
    );
    expect(rows[0].title).toBe("سفارش عمده");
    expect(Number(rows[0].value_rial)).toBe(50_000_000);

    const history = await pipelines.dealStageHistory(biz.id, result.dealId);
    expect(history).toHaveLength(1);
    expect(history[0].fromStageName).toBe("");
  });

  it("does not let a converted lead be edited back into play", async () => {
    const lead = await leads.saveLead(biz.id, { name: "تمام‌شده", phone: "09121230007" }, actor);
    await leads.convertLead(biz.id, lead!.id, {}, actor);

    const edited = await leads.saveLead(
      biz.id,
      { id: lead!.id, name: "نام عوض شد", status: "new" },
      actor,
    );
    expect(edited!.status).toBe("converted");
    expect(edited!.name).toBe("تمام‌شده");
  });
});

describe("the lead list", () => {
  it("filters and counts on the server, so the total is the filtered total", async () => {
    for (let i = 0; i < 25; i += 1) {
      await leads.saveLead(
        biz.id,
        { name: `سرنخ ${i}`, rating: i % 2 === 0 ? "hot" : "cold", status: "new" },
        actor,
      );
    }

    const page = await leads.listLeads(biz.id, { rating: "hot", limit: 5 });
    expect(page.leads).toHaveLength(5);
    // The bug this guards: reporting the page size as the total. 13 of the 25
    // are hot, and the pager has to say 13 — not 5, and not 25.
    expect(page.total).toBe(13);
    expect(page.leads.every((lead) => lead.rating === "hot")).toBe(true);
  });

  it("searches without letting a wildcard character widen the search", async () => {
    await leads.saveLead(biz.id, { name: "شرکت ۱۰۰٪ ایرانی" }, actor);
    await leads.saveLead(biz.id, { name: "چیز دیگری" }, actor);

    const exact = await leads.listLeads(biz.id, { search: "۱۰۰٪" });
    expect(exact.total).toBe(1);

    // A bare `%` must match a literal percent sign, not everything.
    const literal = await leads.listLeads(biz.id, { search: "%" });
    expect(literal.total).toBe(0);
  });
});
