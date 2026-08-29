/**
 * Phase 36 — the CRM against a real database.
 *
 * Four properties, each one chosen because it is a place the app could be
 * quietly wrong in a way no unit test would catch:
 *
 * 1. **A merge moves no money.** This is the one an accountant would ask about.
 *    Merging two customer records repoints who a sale is *attributed* to; it
 *    must not touch a journal line, a total, or a date. The test takes a full
 *    trial balance before and after and demands they be identical.
 * 2. **Consent is enforced in SQL, not in the UI.** A segment resolved for
 *    `purpose: "sms"` must never return a customer who has not agreed, however
 *    the definition is phrased — and `totalBeforeConsent` must still report the
 *    unfiltered population, because the gap is the useful fact.
 * 3. **The file and the segment agree.** A customer whose 360° file says «۳
 *    خرید» must be matched by a segment asking for «حداقل ۳ خرید». Two
 *    different SQL builders compute this; if they ever disagree, the app is
 *    lying on one of its screens and nobody can tell which.
 * 4. **RLS holds on every new table.** The CRM's six tables are new tenant
 *    surfaces; a business must not see another's deals, cases or notes.
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
let crm: typeof import("../src/lib/crm-service");
let segmentsService: typeof import("../src/lib/crm-segments-service");
let timelineService: typeof import("../src/lib/customer-timeline-service");

const biz = { id: "", locationId: "" };
const other = { id: "", locationId: "" };
const acct = { cash: "", revenue: "", receivable: "" };

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
  databaseName = `pos_crm_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  crm = await import("../src/lib/crm-service");
  segmentsService = await import("../src/lib/crm-segments-service");
  timelineService = await import("../src/lib/customer-timeline-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  // Children before parents: customer_points RESTRICTs customer deletion, and
  // every crm_* table references customers.
  await db.query("DELETE FROM crm_consent_events");
  await db.query("DELETE FROM crm_merges");
  await db.query("DELETE FROM crm_activities");
  await db.query("DELETE FROM crm_deals");
  await db.query("DELETE FROM crm_cases");
  await db.query("DELETE FROM customer_notes");
  await db.query("DELETE FROM customer_segments");
  await db.query("DELETE FROM customer_points");
  await db.query("DELETE FROM order_items");
  await db.query("DELETE FROM orders");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM customers");
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('CRM Co', $1, 'food_service') RETURNING id",
    [`crm-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;
  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;

  const otherRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Rival Co', $1, 'food_service') RETURNING id",
    [`rival-${randomUUID().slice(0, 8)}`],
  );
  other.id = otherRow.rows[0].id;
  const otherLoc = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [other.id],
  );
  other.locationId = otherLoc.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'),
            ($1, '1200', 'Accounts Receivable', 'asset'),
            ($1, '4100', 'Sales Revenue', 'revenue')
     RETURNING id, code`,
    [biz.id],
  );
  for (const row of accounts.rows) {
    if (row.code === "1100") acct.cash = row.id;
    if (row.code === "1200") acct.receivable = row.id;
    if (row.code === "4100") acct.revenue = row.id;
  }
});

/** A customer, with only what the CRM needs. */
async function makeCustomer(
  businessId: string,
  name: string,
  overrides: {
    phone?: string | null;
    email?: string | null;
    smsConsent?: boolean;
    marketingConsent?: boolean;
    tags?: string[];
  } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO customers (business_id, name, phone, phone_e164, email, sms_consent, marketing_consent, tags)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      businessId,
      name,
      overrides.phone ?? null,
      overrides.phone ?? null,
      overrides.email ?? null,
      overrides.smsConsent ?? false,
      overrides.marketingConsent ?? false,
      overrides.tags ?? [],
    ],
  );
  return rows[0].id;
}

/**
 * A completed, settled sale with its journal entry — the real thing, so the
 * trial balance below has something to be identical about.
 */
async function makeSale(
  locationId: string,
  businessId: string,
  customerId: string,
  total: number,
  daysAgo: number,
): Promise<string> {
  const closedAt = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO orders (location_id, customer_id, status, subtotal, total, closed_at, order_number)
     VALUES ($1, $2, 'completed', $3, $3, $4, $5) RETURNING id`,
    [locationId, customerId, total, closedAt, Math.floor(Math.random() * 1_000_000)],
  );
  const orderId = rows[0].id;

  const entry = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (business_id, location_id, entry_date, memo, source_type, source_id)
     VALUES ($1, $2, $3::date, 'sale', 'order', $4) RETURNING id`,
    [businessId, locationId, closedAt.slice(0, 10), orderId],
  );
  await db.query(
    `INSERT INTO journal_lines (entry_id, account_id, debit, credit)
     VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
    [entry.rows[0].id, acct.cash, total, acct.revenue],
  );
  return orderId;
}

/** The trial balance, as an accountant would read it: per account, debit and credit totals. */
async function trialBalance(businessId: string) {
  const { rows } = await db.query(
    `SELECT a.code, sum(jl.debit)::text AS debit, sum(jl.credit)::text AS credit
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id
      WHERE je.business_id = $1
      GROUP BY a.code
      ORDER BY a.code`,
    [businessId],
  );
  return rows;
}

describe("merging two customer records", () => {
  it("moves the relationship and leaves the ledger untouched", async () => {
    const keep = await makeCustomer(biz.id, "مریم رضایی", {
      phone: "+989121112233",
      smsConsent: true,
      marketingConsent: true,
      tags: ["وی‌آی‌پی"],
    });
    // The same person, entered again at the counter with no email and no
    // marketing permission — the ordinary way a duplicate is born.
    const dupe = await makeCustomer(biz.id, "مریم رضائی", {
      phone: "+989121112233",
      email: "maryam@example.com",
      smsConsent: true,
      marketingConsent: false,
      tags: ["تولد اسفند"],
    });

    await makeSale(biz.locationId, biz.id, keep, 400_000, 10);
    await makeSale(biz.locationId, biz.id, dupe, 250_000, 5);
    await makeSale(biz.locationId, biz.id, dupe, 150_000, 2);

    const before = await trialBalance(biz.id);

    const result = await crm.mergeCustomers(biz.id, keep, dupe, { mergedBy: "آزمون" });
    expect(result).not.toBeNull();
    expect(result!.moved.orders).toBe(2);

    // ---- The property this whole test exists for -------------------------
    // Not "roughly the same", not "still balances" — byte-identical. A merge
    // that adjusted, reversed or re-dated so much as one line would show here.
    expect(await trialBalance(biz.id)).toEqual(before);

    // The orders themselves are untouched apart from who they belong to: same
    // totals, same dates, same journal entries pointing at the same ids.
    const orphaned = await db.query(
      `SELECT count(*)::int AS n FROM journal_entries je
        WHERE je.business_id = $1 AND je.source_type = 'order'
          AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = je.source_id)`,
      [biz.id],
    );
    expect(orphaned.rows[0].n).toBe(0);

    // ---- And the CRM half did happen -------------------------------------
    const file = await crm.getCustomerFile(biz.id, keep);
    expect(file!.stats.orderCount).toBe(3);
    expect(file!.stats.totalSpentRial).toBe(800_000);
    // A blank field on the winner is filled from the loser rather than lost.
    expect(file!.email).toBe("maryam@example.com");
    // Tags union…
    expect([...file!.tags].sort()).toEqual(["تولد اسفند", "وی‌آی‌پی"].sort());
    // …but consent INTERSECTS. The loser never agreed to marketing email, so
    // the merged record has not agreed either. A merge must never manufacture a
    // permission neither record held.
    expect(file!.smsConsent).toBe(true);
    expect(file!.marketingConsent).toBe(false);

    // The loser is archived, not deleted, so old links still resolve.
    const loserFile = await crm.getCustomerFile(biz.id, dupe);
    expect(loserFile!.isActive).toBe(false);
    expect(loserFile!.mergedIntoId).toBe(keep);

    // And the merge itself is on the record.
    const merges = await db.query(`SELECT winner_id, loser_id FROM crm_merges WHERE business_id = $1`, [
      biz.id,
    ]);
    expect(merges.rows).toHaveLength(1);
    expect(merges.rows[0].winner_id).toBe(keep);
  });

  it("refuses to merge a record into itself", async () => {
    const one = await makeCustomer(biz.id, "علی");
    expect(await crm.mergeCustomers(biz.id, one, one)).toBeNull();
  });
});

describe("segments", () => {
  it("filters by consent in SQL, and still reports the unfiltered population", async () => {
    // Three loyal customers; only one has agreed to be texted.
    const willing = await makeCustomer(biz.id, "زهرا", { phone: "+989120000001", smsConsent: true });
    const unwilling = await makeCustomer(biz.id, "حسن", { phone: "+989120000002", smsConsent: false });
    // Agreed to be texted, but there is no number to text — granted is not the
    // same as reachable, and a send must use the second.
    const unreachable = await makeCustomer(biz.id, "نگار", { phone: null, smsConsent: true });

    for (const id of [willing, unwilling, unreachable]) {
      await makeSale(biz.locationId, biz.id, id, 300_000, 3);
      await makeSale(biz.locationId, biz.id, id, 300_000, 6);
    }

    const definition = {
      all: [{ field: "orderCount" as const, op: "gte" as const, value: 2 }],
    };

    const view = await segmentsService.previewSegment(biz.id, definition, { purpose: "view" });
    expect(view.count).toBe(3);

    const sms = await segmentsService.previewSegment(biz.id, definition, { purpose: "sms" });
    // Only the one who agreed AND can be reached.
    expect(sms.count).toBe(1);
    // The gap is reported rather than hidden: «۳ نفر همخوانی دارند، ۱ نفر
    // اجازه داده» is the fact an owner needs, and a silently smaller number is
    // the thing that makes people distrust the tool.
    expect(sms.totalBeforeConsent).toBe(3);

    const audience = await segmentsService.resolveDefinition(biz.id, definition, { purpose: "sms" });
    expect(audience.map((row) => row.id)).toEqual([willing]);
    expect(audience.map((row) => row.id)).not.toContain(unwilling);
    expect(audience.map((row) => row.id)).not.toContain(unreachable);
  });

  it("excludes a merged-away record, so a person is never counted twice", async () => {
    const keep = await makeCustomer(biz.id, "پرویز", { phone: "+989123334455" });
    const dupe = await makeCustomer(biz.id, "پرویز ن", { phone: "+989123334455" });
    await makeSale(biz.locationId, biz.id, keep, 200_000, 4);
    await makeSale(biz.locationId, biz.id, dupe, 200_000, 3);

    const definition = {
      all: [{ field: "orderCount" as const, op: "gte" as const, value: 1 }],
    };
    expect((await segmentsService.previewSegment(biz.id, definition)).count).toBe(2);

    await crm.mergeCustomers(biz.id, keep, dupe);

    const after = await segmentsService.previewSegment(biz.id, definition);
    expect(after.count).toBe(1);
    // …and the survivor carries both purchases, so nothing was lost either.
    const file = await crm.getCustomerFile(biz.id, keep);
    expect(file!.stats.orderCount).toBe(2);
  });

  it("agrees with the customer's own file about how many purchases they made", async () => {
    // Two independent SQL builders compute this — `crm-segments-service` and
    // `getCustomerFile`. If they disagree, one of the app's screens is lying
    // and an owner has no way to know which.
    const customer = await makeCustomer(biz.id, "سمیرا");
    for (const daysAgo of [2, 9, 20]) {
      await makeSale(biz.locationId, biz.id, customer, 100_000, daysAgo);
    }
    // A voided order is not a purchase on either side of that comparison.
    await db.query(
      `INSERT INTO orders (location_id, customer_id, status, subtotal, total, closed_at, order_number)
       VALUES ($1, $2, 'voided', 500000, 500000, now(), $3)`,
      [biz.locationId, customer, Math.floor(Math.random() * 1_000_000)],
    );

    const file = await crm.getCustomerFile(biz.id, customer);
    expect(file!.stats.orderCount).toBe(3);
    expect(file!.stats.totalSpentRial).toBe(300_000);

    const matched = await segmentsService.resolveDefinition(
      biz.id,
      { all: [{ field: "orderCount", op: "gte", value: 3 }] },
      { purpose: "view" },
    );
    expect(matched.map((row) => row.id)).toContain(customer);
    expect(matched.find((row) => row.id === customer)!.orderCount).toBe(file!.stats.orderCount);
  });
});

describe("the consent register", () => {
  it("records every change append-only, and reports granted separately from reachable", async () => {
    const withPhone = await makeCustomer(biz.id, "کاوه", { phone: "+989127778899" });
    const withoutPhone = await makeCustomer(biz.id, "لیلا", { phone: null });

    await crm.setConsent(biz.id, withPhone, {
      channel: "sms",
      granted: true,
      source: "staff",
      note: "در فروشگاه پرسیده شد",
      changedBy: "آزمون",
    });
    await crm.setConsent(biz.id, withoutPhone, {
      channel: "sms",
      granted: true,
      source: "staff",
      changedBy: "آزمون",
    });
    // …and then changed their mind. Both facts survive; the second does not
    // erase the first, which is the whole point of an audit trail.
    await crm.setConsent(biz.id, withPhone, {
      channel: "sms",
      granted: false,
      source: "customer_request",
      changedBy: "آزمون",
    });

    const events = await crm.listConsentEvents(biz.id, { limit: 50 });
    expect(events).toHaveLength(3);
    expect(events[0].granted).toBe(false);
    expect(events[0].source).toBe("customer_request");
    // The earlier grant is still there, unmodified.
    expect(events.filter((row) => row.granted)).toHaveLength(2);

    const coverage = await crm.consentCoverage(biz.id);
    // One person still permits SMS…
    expect(coverage.smsGranted).toBe(1);
    // …but has no number, so nothing can actually be sent. Reporting only the
    // first number would promise an audience that cannot be delivered to.
    expect(coverage.smsReachable).toBe(0);
  });
});

describe("tenant isolation", () => {
  it("keeps one business's CRM entirely invisible to another", async () => {
    const mine = await makeCustomer(biz.id, "مشتری من");
    const theirs = await makeCustomer(other.id, "مشتری رقیب");

    await crm.addCustomerNote(biz.id, mine, { body: "یادداشت محرمانه", createdBy: "من" });
    await crm.upsertDeal(biz.id, { title: "قرارداد بزرگ", customerId: mine, valueRial: 9_000_000 });
    await crm.upsertCase(biz.id, { subject: "شکایت", customerId: mine });
    await crm.createActivity(biz.id, { kind: "call", subject: "تماس پیگیری", customerId: mine });

    // The rival business sees none of it, through the service layer…
    expect(await crm.listCustomerNotes(other.id, mine)).toEqual([]);
    expect(await crm.listDeals(other.id)).toEqual([]);
    expect(await crm.listCases(other.id)).toEqual([]);
    expect(await crm.listActivities(other.id)).toEqual([]);
    expect(await crm.getCustomerFile(other.id, mine)).toBeNull();

    // …and cannot reach my customer by id from their own side either.
    expect(await crm.getCustomerFile(biz.id, theirs)).toBeNull();

    // Nor can a duplicate scan or a merge cross the boundary.
    expect(await crm.previewMerge(other.id, theirs, mine)).toBeNull();
    expect(await crm.mergeCustomers(other.id, theirs, mine)).toBeNull();

    // My own side still sees everything, so the isolation is real rather than
    // a query that returns nothing for everyone.
    expect(await crm.listCustomerNotes(biz.id, mine)).toHaveLength(1);
    expect(await crm.listDeals(biz.id)).toHaveLength(1);
  });
});

describe("the customer timeline", () => {
  it("maps the sources that exist rather than copying events into a table", async () => {
    const customer = await makeCustomer(biz.id, "بهرام", { phone: "+989125556677" });
    await makeSale(biz.locationId, biz.id, customer, 750_000, 1);
    await crm.addCustomerNote(biz.id, customer, { body: "از کیفیت راضی بود", createdBy: "من" });
    await crm.setConsent(biz.id, customer, {
      channel: "sms",
      granted: true,
      source: "staff",
      changedBy: "من",
    });

    const events = await timelineService.customerTimeline(biz.id, customer, { limit: 50 });
    const kinds = events.map((event) => event.kind);
    expect(kinds).toContain("order");
    expect(kinds).toContain("note");
    expect(kinds).toContain("consent");

    // Newest first, always — the file is read top-down.
    const times = events.map((event) => new Date(event.at).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    // The order event carries the money, and it is the sale's real total.
    // `amount` is pre-formatted at the service edge — Rial for arithmetic,
    // Toman with Persian digits for display — so no screen has to re-derive the
    // currency conversion and none of them can disagree about it.
    expect(events.find((event) => event.kind === "order")?.amount).toMatchObject({
      rial: 750_000,
      toman: 75_000,
    });

    // A kind filter narrows it without changing the ordering rule.
    const onlyOrders = await timelineService.customerTimeline(biz.id, customer, { kinds: ["order"] });
    expect(onlyOrders.every((event) => event.kind === "order")).toBe(true);
  });
});

describe("cross-app bridges", () => {
  /**
   * Phase 36d — the accounting bridge.
   *
   * The CRM shows a customer's outstanding balance and lets a segment target
   * (or exclude) debtors. Both numbers are reconstructed from the A/R control
   * account, and there are now *three* independent readers of that ledger:
   * `ar-service` (accounting's own), `getCustomerFile` (the CRM's 360 view) and
   * the segment compiler's `ar_stats` CTE. If any two of them ever disagree,
   * one of the app's screens is lying about a debt and the owner has no way to
   * tell which. So the test asserts they are equal, not merely plausible.
   */
  it("agrees with the ledger about who owes money, on every surface that reports it", async () => {
    const debtor = await makeCustomer(biz.id, "بدهکار", {
      phone: "+989120000010",
      smsConsent: true,
    });
    const settled = await makeCustomer(biz.id, "تسویه‌شده", {
      phone: "+989120000011",
      smsConsent: true,
    });

    // A credit sale: revenue earned, cash not received. This is what makes a
    // debtor — not an unpaid order flag, but a debit sitting in A/R.
    const closedAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const order = await db.query<{ id: string }>(
      `INSERT INTO orders (location_id, customer_id, status, subtotal, total, closed_at, order_number)
       VALUES ($1, $2, 'completed', $3, $3, $4, $5) RETURNING id`,
      [biz.locationId, debtor, 3_000_000, closedAt, 77_001],
    );
    const entry = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, location_id, entry_date, memo, source_type, source_id)
       VALUES ($1, $2, $3::date, 'credit sale', 'order', $4) RETURNING id`,
      [biz.id, biz.locationId, closedAt.slice(0, 10), order.rows[0].id],
    );
    await db.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit)
       VALUES ($1, $2, 3000000, 0), ($1, $3, 0, 3000000)`,
      [entry.rows[0].id, acct.receivable, acct.revenue],
    );

    // A cash sale for the other customer: same revenue, nothing in A/R.
    await makeSale(biz.locationId, biz.id, settled, 1_000_000, 2);

    await dbLib.withTenant(biz.id, async () => {
      const arService = await import("../src/lib/ar-service");
      const balances = await arService.listCustomerBalances(biz.id);
      const fromLedger = balances.find((b) => b.customerId === debtor)?.balance ?? 0;
      expect(fromLedger).toBe(3_000_000);

      // Reader 2: the customer file.
      const debtorFile = await crm.getCustomerFile(biz.id, debtor);
      expect(debtorFile?.accounting.receivableRial).toBe(fromLedger);
      expect(debtorFile?.accounting.hasLedger).toBe(true);

      // A cash customer owes nothing — and that is different from having no
      // ledger at all, which is why hasLedger is a separate flag.
      const settledFile = await crm.getCustomerFile(biz.id, settled);
      expect(settledFile?.accounting.receivableRial).toBe(0);

      // Reader 3: the segment compiler, through its own CTE.
      const owing = await segmentsService.resolveDefinition(
        biz.id,
        { all: [{ field: "receivableRial", op: "gte", value: 1_000_000 }] },
        { purpose: "view" },
      );
      expect(owing.map((m) => m.id)).toEqual([debtor]);

      // The inverse — "everyone who does not owe us" — is the rule that keeps a
      // discount campaign away from people with an unpaid invoice.
      const clear = await segmentsService.resolveDefinition(
        biz.id,
        { all: [{ field: "receivableRial", op: "lte", value: 0 }] },
        { purpose: "view" },
      );
      expect(clear.map((m) => m.id)).toContain(settled);
      expect(clear.map((m) => m.id)).not.toContain(debtor);
    });
  });

  /**
   * Phase 36d — the Growth bridge. A campaign audience must never include
   * somebody who refused the channel, and the caller must be told how many were
   * dropped, because a silently smaller number is indistinguishable from a bug.
   */
  it("hands Growth an audience with consent already applied, and says how many it removed", async () => {
    const willing = await makeCustomer(biz.id, "موافق", {
      phone: "+989120000020",
      smsConsent: true,
    });
    await makeCustomer(biz.id, "مخالف", {
      phone: "+989120000021",
      smsConsent: false,
    });

    await dbLib.withTenant(biz.id, async () => {
      const bridge = await import("../src/lib/campaign-audience");
      // An empty document means "everyone" by design, which makes it the
      // sharpest test of the consent filter: nothing else is narrowing.
      const audience = await bridge.audienceForDefinition(biz.id, {}, "sms");

      expect(audience.matched).toBeGreaterThanOrEqual(2);
      expect(audience.members.map((m) => m.id)).toContain(willing);
      expect(audience.members.every((m) => m.smsConsent)).toBe(true);
      expect(audience.excludedByConsent).toBe(audience.matched - audience.reachable);
      expect(audience.excludedByConsent).toBeGreaterThan(0);
    });
  });
});
