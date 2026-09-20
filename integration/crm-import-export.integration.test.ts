/**
 * Customer CSV import and export.
 *
 * The properties under test are the ones with legal or irreversible
 * consequences:
 *
 * 1. **Import never grants consent.** A spreadsheet is not permission. A file
 *    that carries a `consent` column must leave every consent flag off.
 * 2. **A dry run writes nothing.** The analysis is what the user approves, so
 *    if it has side effects the approval is meaningless.
 * 3. **Ambiguity is reported, never resolved.** A row matching two customers
 *    is skipped with both candidates named — not silently attached to the
 *    older one.
 * 4. **Re-running a file is safe.** The second run matches instead of
 *    creating, which is what makes partial success recoverable.
 * 5. **Export excludes consent and neutralises formulas**, because the file
 *    leaves the building and is opened by Excel.
 * 6. **Both are audited**, because a bulk read or write of the customer
 *    directory is a privacy event.
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
let importer: typeof import("../src/lib/crm-import-service");
let exporter: typeof import("../src/lib/crm-export-service");
let csv: typeof import("../src/lib/crm-csv");

const biz = { id: "", locationId: "" };
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
  databaseName = `pos_import_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  importer = await import("../src/lib/crm-import-service");
  exporter = await import("../src/lib/crm-export-service");
  csv = await import("../src/lib/crm-csv");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const business = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, industry)
     VALUES ('واردات تست', $1, 'food_service') RETURNING id`,
    [`import-${randomUUID().slice(0, 8)}`],
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
  await db.query(`DELETE FROM crm_audit_events WHERE business_id = $1`, [biz.id]);
  await db.query(`DELETE FROM parties WHERE business_id = $1`, [biz.id]);
});

async function partyCount(): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*) n FROM parties WHERE business_id = $1`,
    [biz.id],
  );
  return Number(rows[0].n);
}

describe("analysing a file", () => {
  it("classifies new rows as creates and writes nothing", async () => {
    const file = "نام,موبایل\nعلی رضایی,09121112233\nمریم احمدی,09121112244\n";
    const analysis = await importer.analyseImport(biz.id, file);

    expect("error" in analysis).toBe(false);
    if ("error" in analysis) return;
    expect(analysis.willCreate).toBe(2);
    expect(analysis.willMatch).toBe(0);
    // The approval is only meaningful if the preview is inert.
    expect(await partyCount()).toBe(0);
  });

  it("rejects a file with no name column rather than guessing one", async () => {
    const analysis = await importer.analyseImport(biz.id, "موبایل,ایمیل\n0912,a@b.c");
    expect(analysis).toEqual({ error: "no_name_column" });
  });

  it("flags an unparseable phone number instead of importing it", async () => {
    const analysis = await importer.analyseImport(biz.id, "نام,موبایل\nعلی,نه-یک-دو");
    if ("error" in analysis) throw new Error("unexpected error");
    expect(analysis.rows[0].outcome).toBe("invalid");
    expect(analysis.invalid).toBe(1);
  });

  it("accepts Persian digits in a phone number", async () => {
    const analysis = await importer.analyseImport(biz.id, "نام,موبایل\nعلی,۰۹۱۲۱۱۱۲۲۳۳");
    if ("error" in analysis) throw new Error("unexpected error");
    // Normalising before matching is what stops «۰۹۱۲…» being treated as a
    // different person from "0912…".
    expect(analysis.rows[0].outcome).toBe("create");
  });

  it("catches a duplicate inside the same file", async () => {
    const file = "نام,موبایل\nعلی,09121112233\nعلی رضایی,09121112233\n";
    const analysis = await importer.analyseImport(biz.id, file);
    if ("error" in analysis) throw new Error("unexpected error");
    expect(analysis.willCreate).toBe(1);
    expect(analysis.rows[1].outcome).toBe("invalid");
    expect(analysis.rows[1].reason).toContain("سطر 2");
  });

  it("matches an existing customer by phone", async () => {
    await db.query(
      `INSERT INTO parties (business_id, name, roles, phone, phone_e164)
       VALUES ($1, 'علی رضایی', ARRAY['customer']::text[], '09121112233', '+989121112233')`,
      [biz.id],
    );
    const analysis = await importer.analyseImport(biz.id, "نام,موبایل\nعلی,09121112233");
    if ("error" in analysis) throw new Error("unexpected error");
    expect(analysis.willMatch).toBe(1);
    expect(analysis.rows[0].matchedName).toBe("علی رضایی");
  });

  it("reports a row matching two customers as a conflict, naming both", async () => {
    // The bug this prevents: quietly picking the older record and welding a
    // stranger's history onto it, three thousand times in one afternoon.
    await db.query(
      `INSERT INTO parties (business_id, name, roles, phone, phone_e164)
       VALUES ($1, 'علی الف', ARRAY['customer']::text[], '09121112233', '+989121112233')`,
      [biz.id],
    );
    await db.query(
      `INSERT INTO parties (business_id, name, roles, email)
       VALUES ($1, 'علی ب', ARRAY['customer']::text[], 'ali@example.com')`,
      [biz.id],
    );
    const analysis = await importer.analyseImport(
      biz.id,
      "نام,موبایل,ایمیل\nعلی,09121112233,ali@example.com",
    );
    if ("error" in analysis) throw new Error("unexpected error");
    expect(analysis.conflicts).toBe(1);
    expect(analysis.rows[0].candidates).toHaveLength(2);
  });

  it("lists a consent column among the ignored ones", async () => {
    const analysis = await importer.analyseImport(
      biz.id,
      "نام,موبایل,sms_consent\nعلی,09121112233,true",
    );
    if ("error" in analysis) throw new Error("unexpected error");
    expect(analysis.ignoredColumns).toContain("sms_consent");
  });
});

describe("committing an import", () => {
  it("creates the customers and audits the run", async () => {
    const file = "نام,موبایل\nعلی رضایی,09121112233\nمریم احمدی,09121112244\n";
    const result = await importer.commitImport(biz.id, file, actor);
    expect(result).toEqual({ created: 2, updated: 0, skipped: 0 });
    expect(await partyCount()).toBe(2);

    const { rows } = await db.query<{ kind: string; detail: Record<string, unknown> }>(
      `SELECT kind, detail FROM crm_audit_events WHERE business_id = $1`,
      [biz.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("import.committed");
    expect(rows[0].detail.consentGranted).toBe(false);
  });

  it("never grants consent, even when the file insists", async () => {
    // The single most important assertion in this file. Legal exposure, not a
    // data-quality nicety.
    const file =
      "نام,موبایل,sms_consent,marketing_consent\nعلی,09121112233,true,YES\n";
    await importer.commitImport(biz.id, file, actor);

    const { rows } = await db.query<{ sms_consent: boolean; marketing_consent: boolean }>(
      `SELECT sms_consent, marketing_consent FROM parties WHERE business_id = $1`,
      [biz.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].sms_consent).toBe(false);
    expect(rows[0].marketing_consent).toBe(false);
  });

  it("writes no consent ledger entry either", async () => {
    await importer.commitImport(
      biz.id,
      "نام,موبایل,sms_consent\nعلی,09121112233,true\n",
      actor,
    );
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) n FROM crm_consent_events WHERE business_id = $1`,
      [biz.id],
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it("stamps first-touch attribution on the created records", async () => {
    await importer.commitImport(biz.id, "نام,موبایل\nعلی,09121112233\n", actor, {
      defaultSource: "import",
    });
    const { rows } = await db.query<{ acquisition_source: string }>(
      `SELECT acquisition_source FROM parties WHERE business_id = $1`,
      [biz.id],
    );
    expect(rows[0].acquisition_source).toBe("import");
  });

  it("is safe to re-run: the second pass matches instead of duplicating", async () => {
    const file = "نام,موبایل\nعلی رضایی,09121112233\n";
    await importer.commitImport(biz.id, file, actor);
    const second = await importer.commitImport(biz.id, file, actor);

    expect(await partyCount()).toBe(1);
    expect(second).toMatchObject({ created: 0 });
  });

  it("skips conflicting rows while importing the clean ones", async () => {
    await db.query(
      `INSERT INTO parties (business_id, name, roles, phone, phone_e164)
       VALUES ($1, 'علی الف', ARRAY['customer']::text[], '09121112233', '+989121112233')`,
      [biz.id],
    );
    await db.query(
      `INSERT INTO parties (business_id, name, roles, email)
       VALUES ($1, 'علی ب', ARRAY['customer']::text[], 'ali@example.com')`,
      [biz.id],
    );
    const file =
      "نام,موبایل,ایمیل\nعلی,09121112233,ali@example.com\nمریم احمدی,09121119999,\n";
    const result = await importer.commitImport(biz.id, file, actor);

    expect(result).toMatchObject({ created: 1, skipped: 1 });
  });

  it("leaves matched records untouched unless updating is asked for", async () => {
    await db.query(
      `INSERT INTO parties (business_id, name, roles, phone, phone_e164, email)
       VALUES ($1, 'علی رضایی', ARRAY['customer']::text[], '09121112233',
               '+989121112233', 'kept@example.com')`,
      [biz.id],
    );
    await importer.commitImport(
      biz.id,
      "نام,موبایل,ایمیل\nعلی,09121112233,new@example.com\n",
      actor,
    );
    const { rows } = await db.query<{ email: string }>(
      `SELECT email FROM parties WHERE business_id = $1`,
      [biz.id],
    );
    expect(rows[0].email).toBe("kept@example.com");
  });

  it("fills a blank field when updating, but does not blank a filled one", async () => {
    await db.query(
      `INSERT INTO parties (business_id, name, roles, phone, phone_e164, email)
       VALUES ($1, 'علی رضایی', ARRAY['customer']::text[], '09121112233',
               '+989121112233', 'kept@example.com')`,
      [biz.id],
    );
    // An empty cell means "I have nothing to say about this field", not
    // "delete what you have" — otherwise a sparse spreadsheet wipes the
    // directory.
    await importer.commitImport(biz.id, "نام,موبایل,ایمیل\nعلی,09121112233,\n", actor, {
      updateExisting: true,
    });
    const { rows } = await db.query<{ email: string }>(
      `SELECT email FROM parties WHERE business_id = $1`,
      [biz.id],
    );
    expect(rows[0].email).toBe("kept@example.com");
  });
});

describe("exporting customers", () => {
  beforeEach(async () => {
    await db.query(
      // phone_e164 is set alongside phone, as migration 0118's backfill and
      // every write path through createParty guarantee. A fixture with only
      // the plaintext column would be a row shape that cannot occur.
      `INSERT INTO parties (business_id, name, roles, phone, phone_e164, tags, sms_consent)
       VALUES ($1, 'علی رضایی', ARRAY['customer']::text[], '09121112233',
               '+989121112233', ARRAY['وفادار']::text[], true)`,
      [biz.id],
    );
  });

  it("produces a header and one row per customer", async () => {
    const { csv: text, rowCount } = await exporter.exportCustomersCsv(biz.id, {}, actor);
    expect(rowCount).toBe(1);
    const sheet = csv.parseCsv(text);
    expect(sheet).toHaveLength(2);
    expect(sheet[1][0]).toBe("علی رضایی");
  });

  it("does not export consent state", async () => {
    // Consent was granted to this business through a recorded channel. A
    // column of `true` in a spreadsheet is how it gets replayed somewhere it
    // was never granted.
    const { csv: text } = await exporter.exportCustomersCsv(biz.id, {}, actor);
    expect(text).not.toMatch(/consent/i);
    expect(text).not.toContain("اجازه");
  });

  it("neutralises a formula in a customer name", async () => {
    await db.query(
      `INSERT INTO parties (business_id, name, roles)
       VALUES ($1, '=HYPERLINK("http://evil","click")', ARRAY['customer']::text[])`,
      [biz.id],
    );
    const { csv: text } = await exporter.exportCustomersCsv(biz.id, {}, actor);
    // Excel executes a cell starting with '='; the apostrophe makes it text.
    expect(text).toContain("'=HYPERLINK");
  });

  it("audits the export with its row count", async () => {
    await exporter.exportCustomersCsv(biz.id, {}, actor);
    const { rows } = await db.query<{ kind: string; detail: Record<string, unknown> }>(
      `SELECT kind, detail FROM crm_audit_events WHERE business_id = $1 AND kind = 'export.generated'`,
      [biz.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].detail.rowCount).toBe(1);
    expect(rows[0].detail.consentExported).toBe(false);
  });

  it("round-trips: an exported file re-imports as matches, not new customers", async () => {
    // The strongest end-to-end statement available about both halves being
    // consistent — and the real workflow when somebody edits the export and
    // sends it back.
    const { csv: text } = await exporter.exportCustomersCsv(biz.id, {}, actor);
    const analysis = await importer.analyseImport(biz.id, text);
    if ("error" in analysis) throw new Error("unexpected error");
    expect(analysis.willCreate).toBe(0);
    expect(analysis.willMatch).toBe(1);
  });

  it("respects tenant isolation", async () => {
    const other = await db.query<{ id: string }>(
      `INSERT INTO businesses (name, slug, industry)
       VALUES ('کسب‌وکار دیگر', $1, 'food_service') RETURNING id`,
      [`other-${randomUUID().slice(0, 8)}`],
    );
    await db.query(
      `INSERT INTO parties (business_id, name, roles)
       VALUES ($1, 'مشتری بیگانه', ARRAY['customer']::text[])`,
      [other.rows[0].id],
    );
    const { csv: text } = await exporter.exportCustomersCsv(biz.id, {}, actor);
    expect(text).not.toContain("مشتری بیگانه");
  });
});
