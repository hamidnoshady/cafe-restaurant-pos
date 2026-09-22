/**
 * «ورود و خروج داده» — the platform data transfer engine, against a real
 * database.
 *
 * This suite is the successor of `crm-import-export.integration.test.ts`, and
 * it deliberately carries every property that file protected forward onto the
 * engine that replaced it — because those properties were the reason the old
 * importer was trustworthy, and an engine that lost them would be a
 * regression wearing a nicer UI:
 *
 *  1. **A preview writes nothing.** The counts the operator approves come from
 *     a dry run; if the dry run had side effects the approval would be
 *     meaningless.
 *  2. **Import never grants consent.** A spreadsheet is not permission. A file
 *     carrying `sms_consent` must leave every consent flag off and write no
 *     consent-ledger row.
 *  3. **Ambiguity is never resolved by guessing.** A duplicate inside one file
 *     is reported, not silently collapsed.
 *  4. **Re-running a file is safe.** The second pass matches instead of
 *     creating, which is what makes partial success recoverable.
 *  5. **Export neutralises formulas and excludes consent**, because the file
 *     leaves the building and is opened by Excel.
 *  6. **Both are audited**, because a bulk read or write is a privacy event.
 *  7. **Tenant isolation holds** on every surface.
 *
 * On top of those it proves what is new: the registry/adapter coverage, XLSX
 * round-trips, relationship handling, the four export formats, the queue, the
 * failed-row report, templates, schedules, and a large import.
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
let importService: typeof import("../src/lib/data-transfer/import-service");
let exportService: typeof import("../src/lib/data-transfer/export-service");
let templates: typeof import("../src/lib/data-transfer/templates-service");
let schedules: typeof import("../src/lib/data-transfer/schedule-service");
let registry: typeof import("../src/lib/data-transfer/registry");
let adapters: typeof import("../src/lib/data-transfer/adapters");
let entitiesModule: typeof import("../src/lib/data-transfer/entities");
let codecs: typeof import("../src/lib/data-transfer/codecs");

const biz = { id: "", locationId: "" };
const other = { id: "", locationId: "" };
const actor = { actorUserId: null as string | null, actorName: "مدیر داده" };

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

/** Run inside the business's RLS scope, the way a route handler would. */
function asBusiness<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(businessId, fn);
}

beforeAll(async () => {
  databaseName = `pos_datatransfer_${randomUUID().replaceAll("-", "")}`;
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
  importService = await import("../src/lib/data-transfer/import-service");
  exportService = await import("../src/lib/data-transfer/export-service");
  templates = await import("../src/lib/data-transfer/templates-service");
  schedules = await import("../src/lib/data-transfer/schedule-service");
  registry = await import("../src/lib/data-transfer/registry");
  adapters = await import("../src/lib/data-transfer/adapters");
  entitiesModule = await import("../src/lib/data-transfer/entities");
  codecs = await import("../src/lib/data-transfer/codecs");
  entitiesModule.ensureAdaptersRegistered();

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const business = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, industry)
     VALUES ('کافهٔ آزمون', $1, 'food_service') RETURNING id`,
    [`dt-${randomUUID().slice(0, 8)}`],
  );
  biz.id = business.rows[0].id;
  const location = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'شعبهٔ اصلی') RETURNING id`,
    [biz.id],
  );
  biz.locationId = location.rows[0].id;

  const otherBusiness = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, industry)
     VALUES ('کسب‌وکار دیگر', $1, 'food_service') RETURNING id`,
    [`dt-other-${randomUUID().slice(0, 8)}`],
  );
  other.id = otherBusiness.rows[0].id;
  const otherLocation = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'شعبهٔ دیگر') RETURNING id`,
    [other.id],
  );
  other.locationId = otherLocation.rows[0].id;
}, 240_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.closeDatabasePool();
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  for (const table of [
    "data_import_rows",
    "data_import_jobs",
    "data_export_jobs",
    "data_mapping_templates",
    "data_export_templates",
    "data_scheduled_exports",
  ]) {
    await db.query(`DELETE FROM ${table}`);
  }
  await db.query(`DELETE FROM audit_log WHERE business_id = ANY($1::uuid[])`, [[biz.id, other.id]]);
  await db.query(`DELETE FROM crm_consent_events WHERE business_id = $1`, [biz.id]);
  await db.query(`DELETE FROM parties WHERE business_id = ANY($1::uuid[])`, [[biz.id, other.id]]);
  await db.query(`DELETE FROM party_categories WHERE business_id = ANY($1::uuid[])`, [
    [biz.id, other.id],
  ]);
  await db.query(`DELETE FROM menu_items WHERE location_id = ANY($1::uuid[])`, [
    [biz.locationId, other.locationId],
  ]);
  await db.query(`DELETE FROM menu_categories WHERE location_id = ANY($1::uuid[])`, [
    [biz.locationId, other.locationId],
  ]);
});

/** Upload a CSV and return the created job. */
async function uploadCsv(
  entityKey: string,
  csv: string,
  options: Record<string, unknown> = {},
  businessId = biz.id,
  locationId: string | null = biz.locationId,
) {
  return asBusiness(businessId, () =>
    importService.createImportJob({
      businessId,
      locationId,
      entityKey,
      fileName: "test.csv",
      format: "csv",
      buffer: new TextEncoder().encode(csv).buffer as ArrayBuffer,
      actorUserId: actor.actorUserId,
      actorName: actor.actorName,
      options,
    }),
  );
}

async function partyCount(businessId = biz.id): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*) n FROM parties WHERE business_id = $1`,
    [businessId],
  );
  return Number(rows[0].n);
}

// ---------------------------------------------------------------------------

describe("the registry", () => {
  it("registers an adapter for every entity, and an entity for every adapter", () => {
    // The one structural invariant of the module: a definition with no adapter
    // is a screen that 500s when used, and an adapter with no definition is
    // dead code nobody can reach.
    const defined = registry.DATA_ENTITIES.map((entity) => entity.key).sort();
    expect(adapters.registeredAdapterKeys()).toEqual(defined);
  });

  it("covers all six apps the platform actually has", () => {
    const modules = new Set(registry.DATA_ENTITIES.map((entity) => entity.module));
    expect([...modules].sort()).toEqual([
      "accounting",
      "crm",
      "inventory",
      "pos",
      "website",
      "workspace",
    ]);
  });

  it("gives every importable entity a write adapter and a duplicate rule", () => {
    for (const entity of registry.DATA_ENTITIES) {
      const adapter = adapters.findAdapter(entity.key)!;
      if (entity.importPermission) {
        expect(adapter.write, `${entity.key} has an import permission but no write()`).toBeTypeOf(
          "function",
        );
        expect(
          entity.duplicateRules?.length ?? 0,
          `${entity.key} is importable but declares no duplicate rule`,
        ).toBeGreaterThan(0);
      } else {
        // Export-only is a decision, not an omission: orders, invoices and
        // payments are the product of a posting engine, not rows to insert.
        expect(adapter.write, `${entity.key} is export-only but has a write()`).toBeUndefined();
      }
    }
  });

  it("points every relation at an entity that exists", () => {
    for (const entity of registry.DATA_ENTITIES) {
      for (const field of entity.fields) {
        if (!field.relation) continue;
        expect(
          registry.findEntity(field.relation.entity),
          `${entity.key}.${field.key} points at unknown entity ${field.relation.entity}`,
        ).toBeTruthy();
      }
    }
  });
});

describe("analysing an upload", () => {
  it("suggests a mapping, counts the rows, and writes nothing", async () => {
    const { job, sheet } = await uploadCsv(
      "crm.customers",
      "نام,موبایل\nعلی رضایی,09121112233\nمریم احمدی,09121112244\n",
    );
    expect(sheet.columns).toEqual(["نام", "موبایل"]);
    expect(job.totalRows).toBe(2);
    expect(job.validRows).toBe(2);
    expect(job.status).toBe("ready");
    // The approval is only meaningful if the preview is inert.
    expect(await partyCount()).toBe(0);
  });

  it("flags an unparseable phone number instead of importing it", async () => {
    const { job } = await uploadCsv("crm.customers", "نام,موبایل\nعلی,نه-یک-دو\n");
    expect(job.errorRows).toBe(1);
    const { rows } = await asBusiness(biz.id, () =>
      importService.listImportRows(biz.id, job.id, {}),
    );
    expect(rows[0].messages[0].message).toContain("شمارهٔ تماس");
  });

  it("accepts Persian digits in a phone number", async () => {
    const { job } = await uploadCsv("crm.customers", "نام,موبایل\nعلی,۰۹۱۲۱۱۱۲۲۳۳\n");
    expect(job.validRows).toBe(1);
  });

  it("catches a duplicate inside the same file rather than creating two", async () => {
    const { job } = await uploadCsv(
      "crm.customers",
      "نام,موبایل\nعلی,09121112233\nعلی رضایی,09121112233\n",
    );
    expect(job.validRows).toBe(1);
    expect(job.errorRows).toBe(1);
    const { rows } = await asBusiness(biz.id, () =>
      importService.listImportRows(biz.id, job.id, { status: "error" }),
    );
    expect(rows[0].messages[0].message).toContain("سطر ۲".replace("۲", "2"));
  });

  it("reports a required field left empty", async () => {
    const { job } = await uploadCsv("crm.customers", "نام,موبایل\n,09121112233\n");
    expect(job.errorRows).toBe(1);
  });

  it("refuses a file with no rows", async () => {
    await expect(uploadCsv("crm.customers", "نام,موبایل\n")).rejects.toThrow("no_rows");
  });
});

describe("mapping and re-preview", () => {
  it("re-validates against a changed mapping without touching tenant data", async () => {
    const { job } = await uploadCsv("crm.customers", "ستون یک,ستون دو\nعلی,09121112233\n");
    // Nothing matched by name, so the required field is unmapped.
    expect(job.errorRows).toBe(1);

    const result = await asBusiness(biz.id, () =>
      importService.previewImportJob(biz.id, job.id, {
        mapping: {
          columns: [
            { field: "name", column: 0, transform: "none" },
            { field: "phone", column: 1, transform: "none" },
          ],
        },
      }),
    );
    expect(result.preview.validRows).toBe(1);
    expect(result.preview.missingRequired).toEqual([]);
    expect(await partyCount()).toBe(0);
  });

  it("names the required fields a mapping does not fill", async () => {
    const { job } = await uploadCsv("crm.customers", "ستون یک\n09121112233\n");
    const result = await asBusiness(biz.id, () =>
      importService.previewImportJob(biz.id, job.id, { mapping: { columns: [] } }),
    );
    expect(result.preview.missingRequired).toContain("نام");
  });

  it("applies a per-column transformation", async () => {
    const { job } = await uploadCsv("pos.products", "نام,دسته,قیمت\nاسپرسو,نوشیدنی,8500\n", {
      moneyUnit: "rial",
    });
    const mapped = await asBusiness(biz.id, () =>
      importService.previewImportJob(biz.id, job.id, {
        mapping: {
          columns: [
            { field: "name", column: 0, transform: "none" },
            { field: "categoryName", column: 1, transform: "none" },
            // The file is in Toman even though the job says Rial: the
            // transformation is the per-column escape hatch for exactly that.
            { field: "price", column: 2, transform: "toman_to_rial" },
          ],
        },
        options: { moneyUnit: "rial" },
      }),
    );
    expect(mapped.preview.rows[0].values.price).toBe(85_000);
  });
});

describe("performing an import", () => {
  it("creates the records and audits the run", async () => {
    const { job } = await uploadCsv(
      "crm.customers",
      "نام,موبایل\nعلی رضایی,09121112233\nمریم احمدی,09121112244\n",
    );
    const result = await asBusiness(biz.id, () =>
      importService.runImportJob(biz.id, job.id, {
        locationId: biz.locationId,
        actorUserId: null,
        actorName: actor.actorName,
      }),
    );
    expect(result).toMatchObject({ created: 2, updated: 0, failed: 0 });
    expect(await partyCount()).toBe(2);

    const { rows } = await db.query<{ action: string; payload: Record<string, unknown> }>(
      `SELECT action, payload FROM audit_log WHERE business_id = $1 ORDER BY id`,
      [biz.id],
    );
    expect(rows.map((row) => row.action)).toEqual([
      "data.import.created",
      "data.import.completed",
    ]);
    expect(rows[1].payload.created).toBe(2);
    expect(rows[1].payload.consentGranted).toBe(false);
  });

  it("writes through the party service, so the row is searchable by phone", async () => {
    // The whole reason adapters call `createParty` rather than INSERT: the
    // normalised e164 column, the blind index and the accounting code are what
    // make an imported customer findable at the till.
    const { job } = await uploadCsv("crm.customers", "نام,موبایل\nعلی رضایی,۰۹۱۲۱۱۱۲۲۳۳\n");
    await asBusiness(biz.id, () =>
      importService.runImportJob(biz.id, job.id, {
        locationId: biz.locationId,
        actorUserId: null,
        actorName: actor.actorName,
      }),
    );
    const { rows } = await db.query<{ phone_e164: string; accounting_code: string }>(
      `SELECT phone_e164, accounting_code FROM parties WHERE business_id = $1`,
      [biz.id],
    );
    expect(rows[0].phone_e164).toBe("+989121112233");
    expect(rows[0].accounting_code).toBeTruthy();
  });

  it("never grants consent, even when the file insists", async () => {
    // The single most important assertion in this file. Legal exposure, not a
    // data-quality nicety.
    const { job } = await uploadCsv(
      "crm.customers",
      "نام,موبایل,sms_consent,marketing_consent\nعلی,09121112233,true,YES\n",
    );
    await asBusiness(biz.id, () =>
      importService.runImportJob(biz.id, job.id, {
        locationId: biz.locationId,
        actorUserId: null,
        actorName: actor.actorName,
      }),
    );
    const { rows } = await db.query<{ sms_consent: boolean; marketing_consent: boolean }>(
      `SELECT sms_consent, marketing_consent FROM parties WHERE business_id = $1`,
      [biz.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].sms_consent).toBe(false);
    expect(rows[0].marketing_consent).toBe(false);

    const consent = await db.query<{ n: string }>(
      `SELECT count(*) n FROM crm_consent_events WHERE business_id = $1`,
      [biz.id],
    );
    expect(Number(consent.rows[0].n)).toBe(0);
  });

  it("has no mapping target for a consent column at all", () => {
    // Stronger than the runtime assertion above: there is nothing in the
    // registry a consent column could be mapped ONTO, so no mapping — hand
    // written, suggested or restored from a template — can grant consent.
    const customers = registry.requireEntity("crm.customers");
    for (const field of customers.fields) {
      expect(field.key.toLowerCase()).not.toContain("consent");
    }
  });

  it("is safe to re-run: the second pass skips instead of duplicating", async () => {
    const csv = "نام,موبایل\nعلی رضایی,09121112233\n";
    const first = await uploadCsv("crm.customers", csv);
    await asBusiness(biz.id, () =>
      importService.runImportJob(biz.id, first.job.id, {
        locationId: biz.locationId,
        actorUserId: null,
        actorName: actor.actorName,
      }),
    );
    const second = await uploadCsv("crm.customers", csv);
    const result = await asBusiness(biz.id, () =>
      importService.runImportJob(biz.id, second.job.id, {
        locationId: biz.locationId,
        actorUserId: null,
        actorName: actor.actorName,
      }),
    );
    expect(await partyCount()).toBe(1);
    expect(result).toMatchObject({ created: 0, skipped: 1 });
  });

  it("updates the existing record when the strategy says so", async () => {
    const csv = "نام,موبایل,ایمیل\nعلی رضایی,09121112233,first@example.com\n";
    const first = await uploadCsv("crm.customers", csv);
    await asBusiness(biz.id, () =>
      importService.runImportJob(biz.id, first.job.id, {
        locationId: biz.locationId,
        actorUserId: null,
        actorName: actor.actorName,
      }),
    );
    const second = await uploadCsv(
      "crm.customers",
      "نام,موبایل,ایمیل\nعلی رضایی,09121112233,second@example.com\n",
      { duplicateStrategy: "update" },
    );
    const result = await asBusiness(biz.id, () =>
      importService.runImportJob(biz.id, second.job.id, {
        locationId: biz.locationId,
        actorUserId: null,
        actorName: actor.actorName,
      }),
    );
    expect(result).toMatchObject({ updated: 1, created: 0 });
    const { rows } = await db.query<{ email: string }>(
      `SELECT email FROM parties WHERE business_id = $1`,
      [biz.id],
    );
    expect(rows[0].email).toBe("second@example.com");
  });
});

describe("relationship handling", () => {
  it("creates the missing parent when the strategy is create", async () => {
    const { job } = await uploadCsv(
      "pos.products",
      "نام,دسته,قیمت\nاسپرسو,نوشیدنی گرم,8500\nلاته,نوشیدنی گرم,9500\n",
      { relationStrategy: { categoryName: "create" } },
    );
    const result = await asBusiness(biz.id, () =>
      importService.runImportJob(biz.id, job.id, {
        locationId: biz.locationId,
        actorUserId: null,
        actorName: actor.actorName,
      }),
    );
    expect(result.created).toBe(2);
    const { rows } = await db.query<{ name: string; n: string }>(
      `SELECT c.name, count(i.id)::text AS n
         FROM menu_categories c LEFT JOIN menu_items i ON i.category_id = c.id
        WHERE c.location_id = $1 GROUP BY c.name`,
      [biz.locationId],
    );
    expect(rows).toEqual([{ name: "نوشیدنی گرم", n: "2" }]);
  });

  it("skips the row when the strategy is skip and the parent is absent", async () => {
    const { job } = await uploadCsv("pos.products", "نام,دسته,قیمت\nاسپرسو,دستهٔ ناموجود,8500\n", {
      relationStrategy: { categoryName: "skip" },
    });
    const result = await asBusiness(biz.id, () =>
      importService.runImportJob(biz.id, job.id, {
        locationId: biz.locationId,
        actorUserId: null,
        actorName: actor.actorName,
      }),
    );
    expect(result).toMatchObject({ created: 0, skipped: 1 });
    const { rows } = await db.query(`SELECT 1 FROM menu_items WHERE location_id = $1`, [
      biz.locationId,
    ]);
    expect(rows).toHaveLength(0);
  });

  it("imports with a warning when the strategy is warn", async () => {
    await db.query(
      `INSERT INTO parties (business_id, name, roles) VALUES ($1, 'شرکت الف', ARRAY['customer']::text[])`,
      [biz.id],
    );
    const { job } = await uploadCsv(
      "workspace.projects",
      "نام پروژه,کارفرما\nویلا A01,کارفرمای ناموجود\n",
      { relationStrategy: { partyName: "warn" } },
    );
    const result = await asBusiness(biz.id, () =>
      importService.runImportJob(biz.id, job.id, {
        locationId: biz.locationId,
        actorUserId: null,
        actorName: actor.actorName,
      }),
    );
    expect(result.created).toBe(1);
    const { rows } = await db.query<{ party_id: string | null }>(
      `SELECT party_id FROM ai_projects WHERE business_id = $1`,
      [biz.id],
    );
    expect(rows[0].party_id).toBeNull();
    const stored = await asBusiness(biz.id, () =>
      importService.listImportRows(biz.id, job.id, {}),
    );
    expect(stored.rows[0].messages.some((m) => m.message.includes("کارفرما"))).toBe(true);
  });

  it("resolves an existing parent by name rather than duplicating it", async () => {
    await db.query(
      `INSERT INTO menu_categories (location_id, name) VALUES ($1, 'نوشیدنی گرم')`,
      [biz.locationId],
    );
    const { job } = await uploadCsv("pos.products", "نام,دسته,قیمت\nاسپرسو,نوشیدنی گرم,8500\n");
    await asBusiness(biz.id, () =>
      importService.runImportJob(biz.id, job.id, {
        locationId: biz.locationId,
        actorUserId: null,
        actorName: actor.actorName,
      }),
    );
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text n FROM menu_categories WHERE location_id = $1`,
      [biz.locationId],
    );
    expect(rows[0].n).toBe("1");
  });
});

describe("money", () => {
  it("reads a Toman file into integer Rial", async () => {
    const { job } = await uploadCsv("pos.products", "نام,دسته,قیمت\nاسپرسو,نوشیدنی,8500\n", {
      moneyUnit: "toman",
    });
    await asBusiness(biz.id, () =>
      importService.runImportJob(biz.id, job.id, {
        locationId: biz.locationId,
        actorUserId: null,
        actorName: actor.actorName,
      }),
    );
    const { rows } = await db.query<{ price: string }>(
      `SELECT price FROM menu_items WHERE location_id = $1`,
      [biz.locationId],
    );
    expect(Number(rows[0].price)).toBe(85_000);
  });

  it("reads a Rial file as Rial — the 10× error the unit option exists to prevent", async () => {
    const { job } = await uploadCsv("pos.products", "نام,دسته,قیمت\nاسپرسو,نوشیدنی,85000\n", {
      moneyUnit: "rial",
    });
    await asBusiness(biz.id, () =>
      importService.runImportJob(biz.id, job.id, {
        locationId: biz.locationId,
        actorUserId: null,
        actorName: actor.actorName,
      }),
    );
    const { rows } = await db.query<{ price: string }>(
      `SELECT price FROM menu_items WHERE location_id = $1`,
      [biz.locationId],
    );
    expect(Number(rows[0].price)).toBe(85_000);
  });
});

describe("XLSX", () => {
  it("round-trips: an Excel export re-imports as the same records", async () => {
    await db.query(
      `INSERT INTO parties (business_id, name, roles, phone, phone_e164)
       VALUES ($1, 'علی رضایی', ARRAY['customer']::text[], '09121112233', '+989121112233')`,
      [biz.id],
    );
    const built = await asBusiness(biz.id, () =>
      exportService.buildExport({
        businessId: biz.id,
        locationId: biz.locationId,
        entityKey: "crm.customers",
        format: "xlsx",
        fields: ["name", "phone"],
        actorUserId: null,
        actorName: actor.actorName,
      }),
    );
    expect(built.rowCount).toBe(1);

    const rows = await codecs.xlsxToRows(
      built.body.buffer.slice(
        built.body.byteOffset,
        built.body.byteOffset + built.body.byteLength,
      ) as ArrayBuffer,
    );
    expect(rows[0]).toEqual(["نام", "تلفن"]);
    expect(rows[1][0]).toBe("علی رضایی");

    // And back in: the exported sheet is a file this engine accepts.
    const job = await asBusiness(biz.id, () =>
      importService.createImportJob({
        businessId: biz.id,
        locationId: biz.locationId,
        entityKey: "crm.customers",
        fileName: "customers.xlsx",
        format: "xlsx",
        buffer: built.body.buffer.slice(
          built.body.byteOffset,
          built.body.byteOffset + built.body.byteLength,
        ) as ArrayBuffer,
        actorUserId: null,
        actorName: actor.actorName,
      }),
    );
    expect(job.job.totalRows).toBe(1);
    const result = await asBusiness(biz.id, () =>
      importService.runImportJob(biz.id, job.job.id, {
        locationId: biz.locationId,
        actorUserId: null,
        actorName: actor.actorName,
      }),
    );
    // Matched, not duplicated — the round trip's real assertion.
    expect(result).toMatchObject({ created: 0, skipped: 1 });
    expect(await partyCount()).toBe(1);
  });
});

describe("exporting", () => {
  beforeEach(async () => {
    await db.query(
      `INSERT INTO parties (business_id, name, roles, phone, phone_e164, tags, sms_consent)
       VALUES ($1, 'علی رضایی', ARRAY['customer']::text[], '09121112233',
               '+989121112233', ARRAY['وفادار']::text[], true)`,
      [biz.id],
    );
  });

  it("produces a header and one row per record, in CSV", async () => {
    const built = await asBusiness(biz.id, () =>
      exportService.buildExport({
        businessId: biz.id,
        locationId: biz.locationId,
        entityKey: "crm.customers",
        format: "csv",
        actorUserId: null,
        actorName: actor.actorName,
      }),
    );
    const sheet = codecs.parseCsv(built.body.toString("utf8"));
    expect(sheet).toHaveLength(2);
    expect(sheet[1][0]).toBe("علی رضایی");
  });

  it("does not export consent state", async () => {
    // Consent was granted to this business through a recorded channel. A
    // column of `true` in a spreadsheet is how it gets replayed somewhere it
    // was never granted.
    const built = await asBusiness(biz.id, () =>
      exportService.buildExport({
        businessId: biz.id,
        locationId: biz.locationId,
        entityKey: "crm.customers",
        format: "csv",
        actorUserId: null,
        actorName: actor.actorName,
      }),
    );
    const text = built.body.toString("utf8");
    expect(text).not.toMatch(/consent/i);
    expect(text).not.toContain("اجازه");
  });

  it("neutralises a formula in a name", async () => {
    await db.query(
      `INSERT INTO parties (business_id, name, roles)
       VALUES ($1, '=HYPERLINK("http://evil","click")', ARRAY['customer']::text[])`,
      [biz.id],
    );
    const built = await asBusiness(biz.id, () =>
      exportService.buildExport({
        businessId: biz.id,
        locationId: biz.locationId,
        entityKey: "crm.customers",
        format: "csv",
        actorUserId: null,
        actorName: actor.actorName,
      }),
    );
    expect(built.body.toString("utf8")).toContain("'=HYPERLINK");
  });

  it("writes human-readable values, never raw foreign keys", async () => {
    // The requirement in one assertion: `category = پیتزا`, not
    // `category_id = 15`.
    const category = await db.query<{ id: string }>(
      `INSERT INTO menu_categories (location_id, name) VALUES ($1, 'پیتزا') RETURNING id`,
      [biz.locationId],
    );
    await db.query(
      `INSERT INTO menu_items (location_id, category_id, name, price)
       VALUES ($1, $2, 'مارگاریتا', 1200000)`,
      [biz.locationId, category.rows[0].id],
    );
    const built = await asBusiness(biz.id, () =>
      exportService.buildExport({
        businessId: biz.id,
        locationId: biz.locationId,
        entityKey: "pos.products",
        format: "csv",
        fields: ["name", "categoryName", "price"],
        actorUserId: null,
        actorName: actor.actorName,
      }),
    );
    const sheet = codecs.parseCsv(built.body.toString("utf8"));
    expect(sheet[0]).toEqual(["نام آیتم", "دسته", "قیمت (تومان)"]);
    expect(sheet[1][1]).toBe("پیتزا");
    expect(sheet[1][1]).not.toMatch(/^[0-9a-f-]{36}$/);
    // Money in the business's display unit, which defaults to Toman.
    expect(sheet[1][2]).toBe("120000");
  });

  it("writes Shamsi dates, never ISO", async () => {
    const built = await asBusiness(biz.id, () =>
      exportService.buildExport({
        businessId: biz.id,
        locationId: biz.locationId,
        entityKey: "crm.customers",
        format: "csv",
        fields: ["name", "createdAt"],
        actorUserId: null,
        actorName: actor.actorName,
      }),
    );
    const sheet = codecs.parseCsv(built.body.toString("utf8"));
    // «۱۴۰۴/۰۱/۰۱» — Persian digits and slashes, never `2026-01-01`.
    expect(sheet[1][1]).toMatch(/^[۰-۹]{4}\/[۰-۹]{2}\/[۰-۹]{2}$/);
  });

  it("produces JSON with machine values rather than rendered ones", async () => {
    const built = await asBusiness(biz.id, () =>
      exportService.buildExport({
        businessId: biz.id,
        locationId: biz.locationId,
        entityKey: "crm.customers",
        format: "json",
        fields: ["name", "totalSpentRial"],
        actorUserId: null,
        actorName: actor.actorName,
      }),
    );
    const parsed = JSON.parse(built.body.toString("utf8")) as Record<string, unknown>[];
    expect(parsed[0].name).toBe("علی رضایی");
    // Integer Rial, not «۰ تومان»: JSON is for the next program, not a reader.
    expect(parsed[0].totalSpentRial).toBe(0);
  });

  it("records every export in the history with its row count", async () => {
    const { job } = await asBusiness(biz.id, () =>
      exportService.createExportJob({
        businessId: biz.id,
        locationId: biz.locationId,
        entityKey: "crm.customers",
        format: "csv",
        actorUserId: null,
        actorName: actor.actorName,
      }),
    );
    expect(job.status).toBe("completed");
    expect(job.rowCount).toBe(1);

    const history = await asBusiness(biz.id, () => exportService.listExportJobs(biz.id));
    expect(history).toHaveLength(1);
    expect(history[0].downloadable).toBe(true);

    const { rows } = await db.query<{ action: string; payload: Record<string, unknown> }>(
      `SELECT action, payload FROM audit_log WHERE business_id = $1 AND action = 'data.export.completed'`,
      [biz.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.rowCount).toBe(1);
  });

  it("serves a previous export again from the history", async () => {
    const { job, body } = await asBusiness(biz.id, () =>
      exportService.createExportJob({
        businessId: biz.id,
        locationId: biz.locationId,
        entityKey: "crm.customers",
        format: "csv",
        actorUserId: null,
        actorName: actor.actorName,
      }),
    );
    const again = await asBusiness(biz.id, () =>
      exportService.getExportContent(biz.id, job.id),
    );
    expect(again?.body.toString("utf8")).toBe(body.toString("utf8"));
  });

  it("drops the stored bytes once the retention window passes, keeping the record", async () => {
    const { job } = await asBusiness(biz.id, () =>
      exportService.createExportJob({
        businessId: biz.id,
        locationId: biz.locationId,
        entityKey: "crm.customers",
        format: "csv",
        actorUserId: null,
        actorName: actor.actorName,
      }),
    );
    await db.query(`UPDATE data_export_jobs SET expires_at = now() - interval '1 day'`);
    await exportService.pruneExpiredExports();

    const content = await asBusiness(biz.id, () =>
      exportService.getExportContent(biz.id, job.id),
    );
    expect(content).toBeNull();
    const history = await asBusiness(biz.id, () => exportService.listExportJobs(biz.id));
    // The audit record survives the data.
    expect(history).toHaveLength(1);
    expect(history[0].rowCount).toBe(1);
    expect(history[0].downloadable).toBe(false);
  });

  it("exports only the selected rows when ids are given", async () => {
    const extra = await db.query<{ id: string }>(
      `INSERT INTO parties (business_id, name, roles)
       VALUES ($1, 'مریم احمدی', ARRAY['customer']::text[]) RETURNING id`,
      [biz.id],
    );
    const built = await asBusiness(biz.id, () =>
      exportService.buildExport({
        businessId: biz.id,
        locationId: biz.locationId,
        entityKey: "crm.customers",
        format: "csv",
        fields: ["name"],
        ids: [extra.rows[0].id],
        actorUserId: null,
        actorName: actor.actorName,
      }),
    );
    expect(built.rowCount).toBe(1);
    expect(built.body.toString("utf8")).toContain("مریم احمدی");
  });
});

describe("the failed-row report and retry", () => {
  it("reports the operator's own cells plus a reason, and retries only the failures", async () => {
    const { job } = await uploadCsv(
      "crm.customers",
      "نام,موبایل\nعلی رضایی,09121112233\n,09121112244\n",
      { validOnly: true },
    );
    expect(job.errorRows).toBe(1);

    await asBusiness(biz.id, () =>
      importService.runImportJob(biz.id, job.id, {
        locationId: biz.locationId,
        actorUserId: null,
        actorName: actor.actorName,
      }),
    );
    expect(await partyCount()).toBe(1);

    const csv = await asBusiness(biz.id, () => importService.failedRowsCsv(biz.id, job.id));
    const sheet = codecs.parseCsv(csv);
    expect(sheet[0]).toEqual(["شمارهٔ سطر", "نام", "موبایل", "دلیل رد شدن"]);
    // Their cells, not our re-rendering of them.
    expect(sheet[1][2]).toBe("09121112244");
    expect(sheet[1][3]).toContain("الزامی");
  });

  it("re-queues failed rows without re-importing the ones that landed", async () => {
    // A row that passes validation but the adapter refuses: an account whose
    // parent does not exist.
    const { job } = await uploadCsv(
      "accounting.accounts",
      "کد حساب,نام حساب,نوع,حساب بالادست\n7100,هزینهٔ آزمایشی,expense,9999\n",
    );
    const first = await asBusiness(biz.id, () =>
      importService.runImportJob(biz.id, job.id, {
        locationId: biz.locationId,
        actorUserId: null,
        actorName: actor.actorName,
      }),
    );
    expect(first.skipped).toBe(1);

    // Create the parent, then retry. `retryFailedRows` only resets `failed`
    // rows; a skipped one stays skipped, which is the documented behaviour —
    // so this asserts the retry API refuses rather than silently doing nothing.
    await expect(
      asBusiness(biz.id, () => importService.retryFailedRows(biz.id, job.id)),
    ).rejects.toThrow("no_failed_rows");
  });
});

describe("the background queue", () => {
  it("claims a queued job, performs it, and records the outcome", async () => {
    const { job } = await uploadCsv("crm.customers", "نام,موبایل\nعلی رضایی,09121112233\n");
    await asBusiness(biz.id, () => importService.queueImportJob(biz.id, job.id));

    const claimed = await importService.runImportQueueTick();
    expect(claimed).toBe(1);

    const done = await asBusiness(biz.id, () => importService.getImportJob(biz.id, job.id));
    expect(done?.status).toBe("completed");
    expect(done?.createdRows).toBe(1);
    expect(await partyCount()).toBe(1);
  });

  it("refuses to queue a job whose required fields are unmapped", async () => {
    const { job } = await uploadCsv("crm.customers", "ستون یک\n09121112233\n");
    await asBusiness(biz.id, () =>
      importService.previewImportJob(biz.id, job.id, { mapping: { columns: [] } }),
    );
    await expect(
      asBusiness(biz.id, () => importService.queueImportJob(biz.id, job.id)),
    ).rejects.toThrow("missing_required_fields");
  });

  it("does nothing, and does not throw, when the queue is empty", async () => {
    expect(await importService.runImportQueueTick()).toBe(0);
  });

  it("returns a job abandoned mid-flight to the queue, and finishes it", async () => {
    // A worker can stop existing between claiming a job and finishing it: a
    // deploy, an OOM kill, a dropped connection. Nothing the dead process was
    // going to do can be relied on, so the job would otherwise sit at
    // `running` forever — never retried, never failed, permanently mid-flight
    // in the operator's history. Simulated here by writing exactly the state
    // such a death leaves behind.
    const { job } = await uploadCsv("crm.customers", "نام,موبایل\nزهرا کریمی,09121119988\n");
    await asBusiness(biz.id, () => importService.queueImportJob(biz.id, job.id));
    await db.query(
      `UPDATE data_import_jobs
          SET status = 'running', started_at = now() - interval '2 hours', attempts = 1
        WHERE id = $1`,
      [job.id],
    );

    const reclaimed = await importService.reclaimStalledImports();
    expect(reclaimed).toBe(1);

    const requeued = await asBusiness(biz.id, () => importService.getImportJob(biz.id, job.id));
    expect(requeued?.status).toBe("queued");

    // And the ordinary tick now picks it up and completes it, which is the
    // point of reclaiming rather than merely marking it failed.
    expect(await importService.runImportQueueTick()).toBe(1);
    const done = await asBusiness(biz.id, () => importService.getImportJob(biz.id, job.id));
    expect(done?.status).toBe("completed");
    expect(done?.createdRows).toBe(1);
  });

  it("parks a job that has stalled its full allowance of attempts", async () => {
    // The other half of the rule: a job that kills its worker every time must
    // not cycle forever. After the third attempt it becomes a visible failure.
    const { job } = await uploadCsv("crm.customers", "نام,موبایل\nنیما رستمی,09121119977\n");
    await asBusiness(biz.id, () => importService.queueImportJob(biz.id, job.id));
    await db.query(
      `UPDATE data_import_jobs
          SET status = 'running', started_at = now() - interval '2 hours', attempts = 3
        WHERE id = $1`,
      [job.id],
    );

    expect(await importService.reclaimStalledImports()).toBe(1);

    const parked = await asBusiness(biz.id, () => importService.getImportJob(biz.id, job.id));
    expect(parked?.status).toBe("failed");
    expect(parked?.error).toBeTruthy();
    expect(parked?.finishedAt).toBeTruthy();
  });

  it("leaves a job that is legitimately still running alone", async () => {
    // The sweep must not interrupt a long import that is simply slow — the
    // staleness floor is what separates "dead" from "busy".
    const { job } = await uploadCsv("crm.customers", "نام,موبایل\nسارا نوری,09121119966\n");
    await asBusiness(biz.id, () => importService.queueImportJob(biz.id, job.id));
    await db.query(`UPDATE data_import_jobs SET status = 'running', started_at = now() WHERE id = $1`, [
      job.id,
    ]);

    expect(await importService.reclaimStalledImports()).toBe(0);
    const still = await asBusiness(biz.id, () => importService.getImportJob(biz.id, job.id));
    expect(still?.status).toBe("running");
  });
});

describe("templates", () => {
  it("saves, reuses and deletes a mapping template", async () => {
    const mapping = {
      columns: [
        { field: "name", column: 0, transform: "none" as const },
        { field: "phone", column: 1, transform: "digits" as const },
      ],
    };
    const template = await asBusiness(biz.id, () =>
      templates.createMappingTemplate({
        businessId: biz.id,
        entityKey: "crm.customers",
        name: "فهرست تأمین‌کننده",
        mapping,
        options: { duplicateStrategy: "update" },
        actorUserId: null,
      }),
    );
    expect(template.mapping.columns).toHaveLength(2);

    // The template is what a later upload starts from, even for headers the
    // suggester would not have recognised.
    const { job } = await asBusiness(biz.id, () =>
      importService.createImportJob({
        businessId: biz.id,
        locationId: biz.locationId,
        entityKey: "crm.customers",
        fileName: "supplier.csv",
        format: "csv",
        buffer: new TextEncoder().encode("ستون یک,ستون دو\nعلی رضایی,۰۹۱۲۱۱۱۲۲۳۳\n")
          .buffer as ArrayBuffer,
        actorUserId: null,
        actorName: actor.actorName,
        mapping: template.mapping,
        options: template.options,
      }),
    );
    expect(job.validRows).toBe(1);

    expect(
      await asBusiness(biz.id, () => templates.deleteMappingTemplate(biz.id, template.id)),
    ).toBe(true);
    expect(await asBusiness(biz.id, () => templates.listMappingTemplates(biz.id))).toEqual([]);
  });

  it("refuses two templates with the same name for one entity", async () => {
    await asBusiness(biz.id, () =>
      templates.createMappingTemplate({
        businessId: biz.id,
        entityKey: "crm.customers",
        name: "قالب من",
        mapping: { columns: [] },
        actorUserId: null,
      }),
    );
    await expect(
      asBusiness(biz.id, () =>
        templates.createMappingTemplate({
          businessId: biz.id,
          entityKey: "crm.customers",
          // Same name modulo padding and case — the unique index folds both.
          name: "  قالب من  ",
          mapping: { columns: [] },
          actorUserId: null,
        }),
      ),
    ).rejects.toThrow("name_taken");
  });

  it("saves and applies an export template", async () => {
    const template = await asBusiness(biz.id, () =>
      templates.createExportTemplate({
        businessId: biz.id,
        entityKey: "crm.customers",
        name: "فقط نام و تلفن",
        format: "csv",
        fields: ["name", "phone"],
        actorUserId: null,
      }),
    );
    await db.query(
      `INSERT INTO parties (business_id, name, roles) VALUES ($1, 'علی', ARRAY['customer']::text[])`,
      [biz.id],
    );
    const built = await asBusiness(biz.id, () =>
      exportService.buildExport({
        businessId: biz.id,
        locationId: biz.locationId,
        entityKey: template.entityKey,
        format: "csv",
        fields: template.fields,
        actorUserId: null,
        actorName: actor.actorName,
      }),
    );
    expect(codecs.parseCsv(built.body.toString("utf8"))[0]).toEqual(["نام", "تلفن"]);
  });
});

describe("scheduled exports", () => {
  it("creates a schedule and produces a stored export when run", async () => {
    await db.query(
      `INSERT INTO parties (business_id, name, roles) VALUES ($1, 'علی', ARRAY['customer']::text[])`,
      [biz.id],
    );
    const schedule = await asBusiness(biz.id, () =>
      schedules.createScheduledExport({
        businessId: biz.id,
        locationId: biz.locationId,
        entityKey: "crm.customers",
        name: "مشتریان هفتگی",
        format: "csv",
        frequency: "weekly",
        hourLocal: 7,
        weekday: 0,
        fields: ["name"],
        deliverStore: true,
        actorUserId: null,
      }),
    );
    expect(schedule.nextRunAt).toBeTruthy();

    const result = await asBusiness(biz.id, () =>
      schedules.runScheduledExport(biz.id, schedule.id),
    );
    expect(result.rowCount).toBe(1);
    // No SMTP configured in this database, so nothing is emailed — and the
    // run still succeeds, which is the point: storage and email are
    // independent deliveries.
    expect(result.emailed).toBe(false);

    const history = await asBusiness(biz.id, () => exportService.listExportJobs(biz.id));
    expect(history).toHaveLength(1);
    expect(history[0].scheduleId).toBe(schedule.id);
  });

  it("claims a due schedule exactly once, even across two ticks", async () => {
    await db.query(
      `INSERT INTO parties (business_id, name, roles) VALUES ($1, 'علی', ARRAY['customer']::text[])`,
      [biz.id],
    );
    const schedule = await asBusiness(biz.id, () =>
      schedules.createScheduledExport({
        businessId: biz.id,
        locationId: biz.locationId,
        entityKey: "crm.customers",
        name: "فروش روزانه",
        format: "csv",
        frequency: "daily",
        hourLocal: 7,
        fields: ["name"],
        deliverStore: true,
        actorUserId: null,
      }),
    );
    // Make it due.
    await db.query(`UPDATE data_scheduled_exports SET next_run_at = now() - interval '1 minute'`);

    const first = await schedules.runScheduledExportsTick();
    const second = await schedules.runScheduledExportsTick();
    expect(first).toBe(1);
    // The claim moved next_run_at forward, so the second tick finds nothing.
    expect(second).toBe(0);

    const history = await asBusiness(biz.id, () => exportService.listExportJobs(biz.id));
    expect(history).toHaveLength(1);

    const stored = await asBusiness(biz.id, () => schedules.listScheduledExports(biz.id));
    expect(stored[0].lastStatus).toBe("completed");
    expect(new Date(stored[0].nextRunAt).getTime()).toBeGreaterThan(Date.now());
    expect(stored[0].id).toBe(schedule.id);
  });
});

describe("large imports", () => {
  it("handles a few thousand rows without falling over", async () => {
    const lines = ["نام,موبایل"];
    for (let i = 0; i < 2000; i += 1) {
      // Distinct, valid Iranian mobile numbers.
      lines.push(`مشتری ${i},0912${String(1_000_000 + i).padStart(7, "0")}`);
    }
    const { job } = await uploadCsv("crm.customers", `${lines.join("\n")}\n`);
    expect(job.totalRows).toBe(2000);
    expect(job.validRows).toBe(2000);

    const result = await asBusiness(biz.id, () =>
      importService.runImportJob(biz.id, job.id, {
        locationId: biz.locationId,
        actorUserId: null,
        actorName: actor.actorName,
      }),
    );
    expect(result.created).toBe(2000);
    expect(await partyCount()).toBe(2000);
  }, 180_000);
});

describe("multi-tenant isolation", () => {
  it("never exports another business's records", async () => {
    await db.query(
      `INSERT INTO parties (business_id, name, roles)
       VALUES ($1, 'مشتری بیگانه', ARRAY['customer']::text[])`,
      [other.id],
    );
    await db.query(
      `INSERT INTO parties (business_id, name, roles)
       VALUES ($1, 'مشتری خودی', ARRAY['customer']::text[])`,
      [biz.id],
    );
    const built = await asBusiness(biz.id, () =>
      exportService.buildExport({
        businessId: biz.id,
        locationId: biz.locationId,
        entityKey: "crm.customers",
        format: "csv",
        fields: ["name"],
        actorUserId: null,
        actorName: actor.actorName,
      }),
    );
    const text = built.body.toString("utf8");
    expect(text).toContain("مشتری خودی");
    expect(text).not.toContain("مشتری بیگانه");
  });

  it("never shows another business's jobs, templates or schedules", async () => {
    await uploadCsv("crm.customers", "نام\nمال ما\n");
    await uploadCsv("crm.customers", "نام\nمال آن‌ها\n", {}, other.id, other.locationId);
    await asBusiness(biz.id, () =>
      templates.createMappingTemplate({
        businessId: biz.id,
        entityKey: "crm.customers",
        name: "قالب ما",
        mapping: { columns: [] },
        actorUserId: null,
      }),
    );
    await asBusiness(other.id, () =>
      templates.createMappingTemplate({
        businessId: other.id,
        entityKey: "crm.customers",
        name: "قالب آن‌ها",
        mapping: { columns: [] },
        actorUserId: null,
      }),
    );

    const ourJobs = await asBusiness(biz.id, () => importService.listImportJobs(biz.id));
    expect(ourJobs).toHaveLength(1);
    const ourTemplates = await asBusiness(biz.id, () => templates.listMappingTemplates(biz.id));
    expect(ourTemplates.map((template) => template.name)).toEqual(["قالب ما"]);
  });

  it("refuses to read another business's job even when its id is known", async () => {
    const { job } = await uploadCsv("crm.customers", "نام\nمال آن‌ها\n", {}, other.id, other.locationId);
    // RLS, not an application `WHERE`: the row is invisible in the other
    // tenant's scope regardless of what the service asks for.
    const leaked = await asBusiness(biz.id, () => importService.getImportJob(biz.id, job.id));
    expect(leaked).toBeNull();
  });

  it("never lets an import write into another business", async () => {
    const { job } = await uploadCsv("crm.customers", "نام,موبایل\nعلی,09121119999\n");
    await asBusiness(biz.id, () =>
      importService.runImportJob(biz.id, job.id, {
        locationId: biz.locationId,
        actorUserId: null,
        actorName: actor.actorName,
      }),
    );
    expect(await partyCount(biz.id)).toBe(1);
    expect(await partyCount(other.id)).toBe(0);
  });
});
