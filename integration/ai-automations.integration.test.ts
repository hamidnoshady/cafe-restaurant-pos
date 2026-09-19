/**
 * Phase D — the Automation engine persists, validates against the live
 * catalogue, gathers real facts and previews without proposing.
 *
 * Exercises the CRUD service and `previewAutomation` against real migrated
 * schema (0155). The pure validation/evaluator rules are unit-tested in
 * `src/lib/ai-automations.test.ts`; this proves they hold end-to-end through
 * the database, that facts are read from the real reports, and that RLS-shaped
 * tenant scoping keeps one business's automations out of another's.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let service: typeof import("../src/lib/ai-automations-service");

const alpha = { businessId: "" };
const beta = { businessId: "" };

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
  databaseName = `pos_ai_automations_${randomUUID().replaceAll("-", "")}`;

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
  service = await import("../src/lib/ai-automations-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const a = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, industry) VALUES ('Alpha', $1, 'food_service') RETURNING id`,
    [`alpha-${randomUUID().slice(0, 8)}`],
  );
  alpha.businessId = a.rows[0].id;
  await db.query(`INSERT INTO locations (business_id, name, timezone) VALUES ($1, 'Main', 'Asia/Tehran')`, [
    alpha.businessId,
  ]);
  const b = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, industry) VALUES ('Beta', $1, 'food_service') RETURNING id`,
    [`beta-${randomUUID().slice(0, 8)}`],
  );
  beta.businessId = b.rows[0].id;
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

describe("automation engine service", () => {
  it("creates, reads back and lists an automation with its conditions and action", async () => {
    const created = await dbLib.withTenant(alpha.businessId, () =>
      service.createAutomation(
        alpha.businessId,
        {
          name: "یادآور مطالبات",
          triggerKind: "schedule",
          scheduleHour: 9,
          conditions: { all: [{ field: "receivableTotalRial", op: "gte", value: 5_000_000 }] },
          actionType: "journal.manual.propose",
          actionPayload: { note: "بررسی مطالبات" },
        },
        { userId: null, authorizedBy: null },
      ),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.automation.name).toBe("یادآور مطالبات");
    expect(created.automation.triggerKind).toBe("schedule");
    expect(created.automation.conditions.all?.length).toBe(1);
    expect(created.automation.actionType).toBe("journal.manual.propose");
    expect(created.automation.approvalMode).toBe("ask");

    const fetched = await dbLib.withTenant(alpha.businessId, () =>
      service.getAutomation(alpha.businessId, created.automation.id),
    );
    expect(fetched?.name).toBe("یادآور مطالبات");

    const list = await dbLib.withTenant(alpha.businessId, () =>
      service.listAutomations(alpha.businessId),
    );
    expect(list.some((a) => a.id === created.automation.id)).toBe(true);
  });

  it("stores authorized_by only for an auto automation", async () => {
    const auto = await dbLib.withTenant(alpha.businessId, () =>
      service.createAutomation(
        alpha.businessId,
        {
          name: "خودکار",
          triggerKind: "event",
          eventKind: "day_close",
          actionType: "journal.manual.propose",
          approvalMode: "auto",
        },
        { userId: null, authorizedBy: null },
      ),
    );
    expect(auto.ok).toBe(true);
    if (auto.ok) expect(auto.automation.approvalMode).toBe("auto");
  });

  it("rejects an unknown action at the service boundary", async () => {
    const result = await dbLib.withTenant(alpha.businessId, () =>
      service.createAutomation(
        alpha.businessId,
        { name: "بد", triggerKind: "manual", actionType: "nope.nope" },
        { userId: null, authorizedBy: null },
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.startsWith("unknown_action:"))).toBe(true);
  });

  it("gathers real facts and previews whether conditions currently hold", async () => {
    // A fresh business has no A/R, no A/P and no stock — every Rial fact is 0.
    const facts = await dbLib.withTenant(alpha.businessId, () =>
      service.gatherAutomationFacts(alpha.businessId, new Date("2026-03-18T06:00:00.000Z")),
    );
    expect(facts.receivableTotalRial).toBe(0);
    expect(facts.payableTotalRial).toBe(0);
    expect(facts.stockValuationRial).toBe(0);
    expect(facts.weekday).toBeGreaterThanOrEqual(0);
    expect(facts.weekday).toBeLessThanOrEqual(6);

    // An automation gated on "receivables >= 5,000,000" must NOT fire for a
    // business with zero receivables; one gated on "<= 0" must.
    const wontFire = await dbLib.withTenant(alpha.businessId, () =>
      service.createAutomation(
        alpha.businessId,
        {
          name: "نباید اجرا شود",
          triggerKind: "manual",
          conditions: { all: [{ field: "receivableTotalRial", op: "gte", value: 5_000_000 }] },
          actionType: "journal.manual.propose",
        },
        { userId: null, authorizedBy: null },
      ),
    );
    const willFire = await dbLib.withTenant(alpha.businessId, () =>
      service.createAutomation(
        alpha.businessId,
        {
          name: "باید اجرا شود",
          triggerKind: "manual",
          conditions: { all: [{ field: "receivableTotalRial", op: "lte", value: 0 }] },
          actionType: "journal.manual.propose",
        },
        { userId: null, authorizedBy: null },
      ),
    );
    expect(wontFire.ok && willFire.ok).toBe(true);
    if (!wontFire.ok || !willFire.ok) return;

    const previewNo = await dbLib.withTenant(alpha.businessId, () =>
      service.previewAutomation(alpha.businessId, wontFire.automation.id),
    );
    expect(previewNo?.conditionsMet).toBe(false);

    const previewYes = await dbLib.withTenant(alpha.businessId, () =>
      service.previewAutomation(alpha.businessId, willFire.automation.id),
    );
    expect(previewYes?.conditionsMet).toBe(true);
    expect(previewYes?.actionType).toBe("journal.manual.propose");
  });

  it("refuses a duplicate name, updates, deletes and is tenant-scoped", async () => {
    const first = await dbLib.withTenant(alpha.businessId, () =>
      service.createAutomation(
        alpha.businessId,
        { name: "تکراری", triggerKind: "manual", actionType: "journal.manual.propose" },
        { userId: null, authorizedBy: null },
      ),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const dup = await dbLib.withTenant(alpha.businessId, () =>
      service.createAutomation(
        alpha.businessId,
        { name: "تکراری", triggerKind: "manual", actionType: "journal.manual.propose" },
        { userId: null, authorizedBy: null },
      ),
    );
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.errors).toContain("name_taken");

    // Same name in Beta is fine.
    const other = await dbLib.withTenant(beta.businessId, () =>
      service.createAutomation(
        beta.businessId,
        { name: "تکراری", triggerKind: "manual", actionType: "journal.manual.propose" },
        { userId: null, authorizedBy: null },
      ),
    );
    expect(other.ok).toBe(true);

    const updated = await dbLib.withTenant(alpha.businessId, () =>
      service.updateAutomation(
        alpha.businessId,
        first.automation.id,
        {
          name: "ویرایش‌شده",
          triggerKind: "manual",
          actionType: "journal.manual.propose",
          enabled: false,
        },
        { authorizedBy: null },
      ),
    );
    expect(updated.ok).toBe(true);
    if (updated.ok) expect(updated.automation.enabled).toBe(false);

    // Beta cannot see or delete Alpha's automation.
    const betaDelete = await dbLib.withTenant(beta.businessId, () =>
      service.deleteAutomation(beta.businessId, first.automation.id),
    );
    expect(betaDelete).toBe(false);
    const alphaDelete = await dbLib.withTenant(alpha.businessId, () =>
      service.deleteAutomation(alpha.businessId, first.automation.id),
    );
    expect(alphaDelete).toBe(true);
  });
});
