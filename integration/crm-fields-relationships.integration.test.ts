/**
 * Typed custom fields, party relationships, saved views and segment versions.
 *
 * What each group is really protecting:
 *
 * - **Custom fields.** A field's type cannot change once it holds answers,
 *   because reinterpreting stored text as a number either discards what
 *   somebody wrote or invents a figure they never entered. Values are typed on
 *   the way in, so no report has to cast user input at read time.
 * - **Relationships.** A graph over `parties`, not a second hierarchy. The
 *   subtle parts are symmetry (a household is mutual; a referral is not) and
 *   surviving a merge without violating a constraint.
 * - **Saved views.** User-authored filter documents that another member's
 *   browser executes — so the vocabulary is closed, and privacy is enforced in
 *   SQL rather than by the caller remembering to filter.
 * - **Segment versions.** A campaign must stay able to answer "who did this
 *   reach?" after the segment's rules have been edited.
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
let fields: typeof import("../src/lib/crm-custom-fields-service");
let rels: typeof import("../src/lib/crm-relationship-service");
let views: typeof import("../src/lib/crm-saved-views-service");
let segments: typeof import("../src/lib/crm-segments-service");

const biz = { id: "", locationId: "" };
/** Two real members. `owner_user_id` is a foreign key, so invented uuids will not do. */
const members = { mine: "", theirs: "" };
const actor = { name: "مدیر فروش", userId: null };

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
  databaseName = `pos_fields_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  fields = await import("../src/lib/crm-custom-fields-service");
  rels = await import("../src/lib/crm-relationship-service");
  views = await import("../src/lib/crm-saved-views-service");
  segments = await import("../src/lib/crm-segments-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const business = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, industry)
     VALUES ('میدان تست', $1, 'food_service') RETURNING id`,
    [`fields-${randomUUID().slice(0, 8)}`],
  );
  biz.id = business.rows[0].id;
  const location = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'شعبهٔ اصلی') RETURNING id`,
    [biz.id],
  );
  biz.locationId = location.rows[0].id;

  const mine = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash)
     VALUES ($1, 'manager', 'کاربر الف', 'x') RETURNING id`,
    [biz.id],
  );
  members.mine = mine.rows[0].id;
  const theirs = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash)
     VALUES ($1, 'cashier', 'کاربر ب', 'x') RETURNING id`,
    [biz.id],
  );
  members.theirs = theirs.rows[0].id;
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
  await db.query(`DELETE FROM crm_audit_events WHERE business_id = $1`, [biz.id]);
  await db.query(`DELETE FROM crm_custom_field_values WHERE business_id = $1`, [biz.id]);
  await db.query(`DELETE FROM crm_custom_fields WHERE business_id = $1`, [biz.id]);
  await db.query(`DELETE FROM crm_party_relationships WHERE business_id = $1`, [biz.id]);
  await db.query(`DELETE FROM crm_saved_views WHERE business_id = $1`, [biz.id]);
  await db.query(`DELETE FROM customer_segment_versions WHERE business_id = $1`, [biz.id]);
  await db.query(`DELETE FROM customer_segments WHERE business_id = $1`, [biz.id]);
  await db.query(`DELETE FROM parties WHERE business_id = $1`, [biz.id]);
});

async function makeParty(name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, roles)
     VALUES ($1, $2, ARRAY['customer']::text[]) RETURNING id`,
    [biz.id, name],
  );
  return rows[0].id;
}

describe("custom field definitions", () => {
  it("derives an ASCII key from a Latin label", async () => {
    const result = await fields.saveCustomField(
      biz.id,
      { target: "party", label: "Contract Number", fieldType: "text" },
      actor,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.field.key).toBe("contract_number");
  });

  it("falls back to a positional key for a Persian label", async () => {
    // The key travels through CSV headers, API payloads and segment
    // definitions; a Persian string with RTL marks in that position is a
    // reliable encoding bug. The label stays Persian — that is what people
    // read.
    const result = await fields.saveCustomField(
      biz.id,
      { target: "party", label: "شمارهٔ قرارداد", fieldType: "text" },
      actor,
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.field.key).toMatch(/^field_\d+$/);
    expect(result.field.label).toBe("شمارهٔ قرارداد");
  });

  it("requires options for a select field", async () => {
    const result = await fields.saveCustomField(
      biz.id,
      { target: "party", label: "Tier", fieldType: "select", options: [] },
      actor,
    );
    expect(result).toEqual({ ok: false, error: "options_required" });
  });

  it("refuses to change the type once values exist", async () => {
    // Reinterpreting «حدود ۵۰۰ هزار» as money either discards the answer or
    // invents a number. Archive and re-create instead.
    const created = await fields.saveCustomField(
      biz.id,
      { target: "party", label: "Budget", fieldType: "text" },
      actor,
    );
    if (!created.ok) throw new Error(created.error);
    const party = await makeParty("علی");
    await fields.setCustomValues(biz.id, "party", party, { budget: "حدود ۵۰۰ هزار" }, actor);

    const changed = await fields.saveCustomField(
      biz.id,
      {
        id: created.field.id,
        target: "party",
        label: "Budget",
        fieldType: "money",
      },
      actor,
    );
    expect(changed).toEqual({ ok: false, error: "type_change_blocked" });
  });

  it("archives rather than deletes, keeping stored answers readable", async () => {
    const created = await fields.saveCustomField(
      biz.id,
      { target: "party", label: "Budget", fieldType: "text" },
      actor,
    );
    if (!created.ok) throw new Error(created.error);
    const party = await makeParty("علی");
    await fields.setCustomValues(biz.id, "party", party, { budget: "۵۰۰" }, actor);

    expect(await fields.archiveCustomField(biz.id, created.field.id, actor)).toBe(true);
    expect(await fields.listCustomFields(biz.id, "party")).toHaveLength(0);
    // The answer survives: a value whose definition was archived is still part
    // of that customer's history.
    const stored = await fields.customValuesFor(biz.id, "party", party);
    expect(stored.map((v) => v.key)).toContain("budget");
  });
});

describe("typing a submitted value", () => {
  const field = (over: Partial<Parameters<typeof fields.coerceCustomValue>[0]>) =>
    ({ fieldType: "text", options: [], isRequired: false, ...over }) as Parameters<
      typeof fields.coerceCustomValue
    >[0];

  it("accepts Persian digits in a number", () => {
    const result = fields.coerceCustomValue(field({ fieldType: "number" }), "۱۲۳۴");
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value.number).toBe(1234);
  });

  it("strips thousands separators", () => {
    const result = fields.coerceCustomValue(field({ fieldType: "number" }), "۱٬۲۳۴");
    if (!result.ok) throw new Error(result.error);
    expect(result.value.number).toBe(1234);
  });

  it("rejects text in a number field", () => {
    expect(fields.coerceCustomValue(field({ fieldType: "number" }), "زیاد")).toEqual({
      ok: false,
      error: "not_a_number",
    });
  });

  it("rejects a date that does not exist", () => {
    // 1404-12-31 style off-by-one errors are why this round-trips rather than
    // regex-matching: 2026-02-31 parses in a naive implementation.
    expect(fields.coerceCustomValue(field({ fieldType: "date" }), "2026-02-31")).toEqual({
      ok: false,
      error: "not_a_date",
    });
  });

  it("rejects a value outside a select's options", () => {
    expect(
      fields.coerceCustomValue(
        field({ fieldType: "select", options: ["طلایی", "نقره‌ای"] }),
        "برنزی",
      ),
    ).toEqual({ ok: false, error: "not_an_option" });
  });

  it("rejects an empty value for a required field", () => {
    expect(fields.coerceCustomValue(field({ isRequired: true }), "")).toEqual({
      ok: false,
      error: "required",
    });
  });
});

describe("writing custom values", () => {
  it("reports every failure at once rather than one per round trip", async () => {
    const a = await fields.saveCustomField(
      biz.id,
      { target: "party", label: "Budget", fieldType: "number" },
      actor,
    );
    const b = await fields.saveCustomField(
      biz.id,
      { target: "party", label: "Signed On", fieldType: "date" },
      actor,
    );
    if (!a.ok || !b.ok) throw new Error("setup failed");
    const party = await makeParty("علی");

    const result = await fields.setCustomValues(
      biz.id,
      "party",
      party,
      { budget: "زیاد", signed_on: "دیروز" },
      actor,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures).toHaveLength(2);
  });

  it("writes nothing when any value fails", async () => {
    const a = await fields.saveCustomField(
      biz.id,
      { target: "party", label: "Budget", fieldType: "number" },
      actor,
    );
    const b = await fields.saveCustomField(
      biz.id,
      { target: "party", label: "Signed On", fieldType: "date" },
      actor,
    );
    if (!a.ok || !b.ok) throw new Error("setup failed");
    const party = await makeParty("علی");

    await fields.setCustomValues(
      biz.id,
      "party",
      party,
      { budget: "1000", signed_on: "دیروز" },
      actor,
    );
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) n FROM crm_custom_field_values WHERE business_id = $1`,
      [biz.id],
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it("ignores an unknown key from a stale tab", async () => {
    const created = await fields.saveCustomField(
      biz.id,
      { target: "party", label: "Budget", fieldType: "number" },
      actor,
    );
    if (!created.ok) throw new Error(created.error);
    const party = await makeParty("علی");

    const result = await fields.setCustomValues(
      biz.id,
      "party",
      party,
      { budget: "1000", deleted_field: "x" },
      actor,
    );
    expect(result).toMatchObject({ ok: true });
  });
});

describe("relationships", () => {
  it("links two parties and reads the edge from the far end as an inverse", async () => {
    const person = await makeParty("علی");
    const company = await makeParty("شرکت الف");
    const linked = await rels.linkParties(
      biz.id,
      { fromPartyId: person, toPartyId: company, kind: "contact_of" },
      actor,
    );
    expect(linked.ok).toBe(true);

    const fromPerson = await rels.relationshipsFor(biz.id, person);
    expect(fromPerson).toHaveLength(1);
    expect(fromPerson[0].inverse).toBe(false);

    // The company's file shows the same edge, labelled from its side.
    const fromCompany = await rels.relationshipsFor(biz.id, company);
    expect(fromCompany).toHaveLength(1);
    expect(fromCompany[0].inverse).toBe(true);
  });

  it("refuses to link a party to itself", async () => {
    const person = await makeParty("علی");
    expect(
      await rels.linkParties(
        biz.id,
        { fromPartyId: person, toPartyId: person, kind: "household" },
        actor,
      ),
    ).toEqual({ ok: false, error: "self_link" });
  });

  it("refuses a party from another business", async () => {
    // The ids come from a browser; without this check another tenant's
    // customer name appears on this business's screen.
    const other = await db.query<{ id: string }>(
      `INSERT INTO businesses (name, slug, industry)
       VALUES ('دیگری', $1, 'food_service') RETURNING id`,
      [`rel-other-${randomUUID().slice(0, 8)}`],
    );
    const mine = await makeParty("علی");
    const theirs = await db.query<{ id: string }>(
      `INSERT INTO parties (business_id, name, roles)
       VALUES ($1, 'بیگانه', ARRAY['customer']::text[]) RETURNING id`,
      [other.rows[0].id],
    );
    expect(
      await rels.linkParties(
        biz.id,
        { fromPartyId: mine, toPartyId: theirs.rows[0].id, kind: "contact_of" },
        actor,
      ),
    ).toEqual({ ok: false, error: "not_found" });
  });

  it("mirrors a household so both files show it", async () => {
    const a = await makeParty("علی");
    const b = await makeParty("مریم");
    await rels.linkParties(biz.id, { fromPartyId: a, toPartyId: b, kind: "household" }, actor);

    // Stored both ways...
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) n FROM crm_party_relationships WHERE business_id = $1`,
      [biz.id],
    );
    expect(Number(rows[0].n)).toBe(2);
    // ...but shown once per file, not twice.
    expect(await rels.relationshipsFor(biz.id, a)).toHaveLength(1);
    expect(await rels.relationshipsFor(biz.id, b)).toHaveLength(1);
  });

  it("does not mirror a referral, because referral has a direction", async () => {
    // A referred B is a fact about attribution. Mirroring it would claim B
    // referred A, which is simply false.
    const a = await makeParty("علی");
    const b = await makeParty("مریم");
    await rels.linkParties(biz.id, { fromPartyId: a, toPartyId: b, kind: "referred_by" }, actor);
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) n FROM crm_party_relationships WHERE business_id = $1`,
      [biz.id],
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  it("keeps only one primary contact of a kind", async () => {
    const company = await makeParty("شرکت الف");
    const first = await makeParty("علی");
    const second = await makeParty("مریم");
    await rels.linkParties(
      biz.id,
      { fromPartyId: first, toPartyId: company, kind: "billing_contact", isPrimary: true },
      actor,
    );
    await rels.linkParties(
      biz.id,
      { fromPartyId: second, toPartyId: company, kind: "billing_contact", isPrimary: true },
      actor,
    );

    const { rows } = await db.query<{ from_party_id: string }>(
      `SELECT from_party_id FROM crm_party_relationships
        WHERE business_id = $1 AND kind = 'billing_contact' AND is_primary`,
      [biz.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].from_party_id).toBe(second);
  });

  it("removes both halves of a household when unlinked", async () => {
    const a = await makeParty("علی");
    const b = await makeParty("مریم");
    const linked = await rels.linkParties(
      biz.id,
      { fromPartyId: a, toPartyId: b, kind: "household" },
      actor,
    );
    if (!linked.ok) throw new Error(linked.error);

    expect(await rels.unlinkParties(biz.id, linked.id, actor)).toBe(true);
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) n FROM crm_party_relationships WHERE business_id = $1`,
      [biz.id],
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it("audits both linking and unlinking", async () => {
    const a = await makeParty("علی");
    const b = await makeParty("شرکت الف");
    const linked = await rels.linkParties(
      biz.id,
      { fromPartyId: a, toPartyId: b, kind: "contact_of" },
      actor,
    );
    if (!linked.ok) throw new Error(linked.error);
    await rels.unlinkParties(biz.id, linked.id, actor);

    const { rows } = await db.query<{ kind: string }>(
      `SELECT kind FROM crm_audit_events WHERE business_id = $1 ORDER BY created_at`,
      [biz.id],
    );
    expect(rows.map((r) => r.kind)).toEqual(["relationship.linked", "relationship.unlinked"]);
  });
});

describe("saved views", () => {
  it("keeps one member's private view out of another's list", async () => {
    const { mine, theirs } = members;
    await views.saveView(
      biz.id,
      { entity: "customers", name: "مال من", filters: { q: "x" }, shared: false },
      { name: "الف", userId: mine },
    );
    expect(await views.listSavedViews(biz.id, "customers", theirs)).toHaveLength(0);
    expect(await views.listSavedViews(biz.id, "customers", mine)).toHaveLength(1);
  });

  it("shows a shared view to everybody", async () => {
    await views.saveView(
      biz.id,
      { entity: "customers", name: "مشترک", filters: {}, shared: true },
      { name: "الف", userId: members.mine },
    );
    const seen = await views.listSavedViews(biz.id, "customers", members.theirs);
    expect(seen).toHaveLength(1);
  });

  it("drops filter keys the entity does not define", async () => {
    // A saved view is user-authored content another member's browser
    // executes. The closed vocabulary is what makes that safe.
    const saved = await views.saveView(
      biz.id,
      {
        entity: "customers",
        name: "نما",
        filters: { q: "علی", "; DROP TABLE parties": "1", stageId: "x" },
        shared: true,
      },
      { name: "الف", userId: null },
    );
    if (!saved.ok) throw new Error(saved.error);
    // `stageId` is a deals filter, not a customers one, so it goes too.
    expect(saved.view.filters).toEqual({ q: "علی" });
  });

  it("refuses to let one member overwrite another's private view", async () => {
    const mine = members.mine;
    const saved = await views.saveView(
      biz.id,
      { entity: "customers", name: "مال من", filters: {}, shared: false },
      { name: "الف", userId: mine },
    );
    if (!saved.ok) throw new Error(saved.error);

    const attempt = await views.saveView(
      biz.id,
      { id: saved.view.id, entity: "customers", name: "دزدیده", filters: {}, shared: false },
      { name: "ب", userId: members.theirs },
    );
    expect(attempt).toEqual({ ok: false, error: "forbidden" });
  });

  it("does not delete another member's private view", async () => {
    const saved = await views.saveView(
      biz.id,
      { entity: "customers", name: "مال من", filters: {}, shared: false },
      { name: "الف", userId: members.mine },
    );
    if (!saved.ok) throw new Error(saved.error);
    expect(
      await views.deleteSavedView(biz.id, saved.view.id, { userId: members.theirs }),
    ).toBe(false);
  });
});

describe("segment versioning", () => {
  it("records version 1 when a segment is created", async () => {
    const segment = await segments.createSegment(biz.id, {
      name: "مشتریان وفادار",
      definition: { all: [{ field: "orderCount", op: "gte", value: 5 }] },
    });
    const history = await segments.segmentVersions(biz.id, segment.id);
    expect(history).toHaveLength(1);
    expect(history[0].version).toBe(1);
  });

  it("mints a new version when the rules change", async () => {
    const segment = await segments.createSegment(biz.id, {
      name: "مشتریان وفادار",
      definition: { all: [{ field: "orderCount", op: "gte", value: 5 }] },
    });
    await segments.updateSegment(biz.id, segment.id, {
      definition: { all: [{ field: "orderCount", op: "gte", value: 10 }] },
    });

    const history = await segments.segmentVersions(biz.id, segment.id);
    expect(history.map((v) => v.version)).toEqual([2, 1]);
    // The old definition is still readable — that is the entire point.
    const v1 = history.find((v) => v.version === 1);
    expect(v1?.definition).toEqual({ all: [{ field: "orderCount", op: "gte", value: 5 }] });
  });

  it("does not mint a version for a rename", async () => {
    // Versions explain who a campaign reached, which is a function of the
    // rules, not the label. Bumping on a rename fills the history with
    // versions that differ in nothing.
    const segment = await segments.createSegment(biz.id, {
      name: "قدیمی",
      definition: { all: [{ field: "orderCount", op: "gte", value: 5 }] },
    });
    await segments.updateSegment(biz.id, segment.id, { name: "جدید" });
    expect(await segments.segmentVersions(biz.id, segment.id)).toHaveLength(1);
  });
});
