/**
 * Migration 0128 — an app can be switched off with a reason («به‌زودی»,
 * «در حال تعمیر», «نسخهٔ آزمایشی», «غیرفعال»), platform-wide or for one
 * business.
 *
 * The pure resolution rules are unit-tested in src/lib/app-availability.test.ts;
 * this proves the database round trip the console and every guard depend on:
 * the seeded catalogue, a platform-wide state reaching a business, an override
 * taking precedence over it, clearing that override, and — the part a bug here
 * would be worst — that one business's override never leaks into another's.
 *
 * Same shape as feature-gating.integration.test.ts, deliberately: this is the
 * second axis of the same idea and should be readable next to the first.
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
let service: typeof import("../src/lib/app-availability-service");

const biz = { id: "" };

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
  databaseName = `pos_appavail_${randomUUID().replaceAll("-", "")}`;

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
  service = await import("../src/lib/app-availability-service");

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
  await db.query("DELETE FROM business_app_availability");
  await db.query("UPDATE app_availability SET state = 'available', note = NULL, available_from = NULL");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Apps Co', $1) RETURNING id",
    [`apps-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;
});

describe("effectiveAppAvailability", () => {
  it("seeds every registry app as available, so the migration changes no behaviour", async () => {
    const map = await service.effectiveAppAvailability(biz.id);
    for (const app of ["sales", "crm", "growth", "operations", "accounting", "connections", "settings"] as const) {
      expect(map[app].state).toBe("available");
      expect(map[app].usable).toBe(true);
      expect(map[app].badged).toBe(false);
    }
  });

  it("a platform-wide state reaches a business that has no override", async () => {
    await service.setPlatformAppAvailability(
      "crm",
      { state: "coming_soon", note: null, availableFrom: "2026-09-20" },
      null,
    );
    const map = await service.effectiveAppAvailability(biz.id);
    expect(map.crm.state).toBe("coming_soon");
    expect(map.crm.usable).toBe(false);
    expect(map.crm.source).toBe("platform");
    // Stored as a Gregorian `date`; the wire keeps it ISO and the UI renders Shamsi.
    expect(map.crm.availableFrom).toBe("2026-09-20");
    expect(await service.isAppAvailable(biz.id, "crm")).toBe(false);
    // Other apps are untouched.
    expect(map.sales.usable).toBe(true);
  });

  it("`beta` labels an app without blocking it", async () => {
    await service.setPlatformAppAvailability("growth", { state: "beta" }, null);
    const map = await service.effectiveAppAvailability(biz.id);
    expect(map.growth.state).toBe("beta");
    expect(map.growth.usable).toBe(true);
    expect(map.growth.badged).toBe(true);
    expect(await service.isAppAvailable(biz.id, "growth")).toBe(true);
  });

  it("a per-business override wins over the platform state, in both directions", async () => {
    await service.setPlatformAppAvailability("operations", { state: "maintenance" }, null);
    expect(await service.isAppAvailable(biz.id, "operations")).toBe(false);

    // Letting one business back in while the platform stays down.
    await service.setBusinessAppAvailability(biz.id, "operations", { state: "available" }, null);
    const back = await service.effectiveAppAvailability(biz.id);
    expect(back.operations.usable).toBe(true);
    expect(back.operations.source).toBe("business");

    // And the other way: down for one business while the platform is up.
    await service.setPlatformAppAvailability("accounting", { state: "available" }, null);
    await service.setBusinessAppAvailability(
      biz.id,
      "accounting",
      { state: "maintenance", note: "انتقال داده", availableFrom: "2026-09-05" },
      null,
    );
    const map = await service.effectiveAppAvailability(biz.id);
    expect(map.accounting.usable).toBe(false);
    expect(map.accounting.notice).toBe("انتقال داده");
    expect(map.accounting.availableFrom).toBe("2026-09-05");
  });

  it("clearing an override falls back to the platform state", async () => {
    await service.setPlatformAppAvailability("connections", { state: "coming_soon" }, null);
    await service.setBusinessAppAvailability(biz.id, "connections", { state: "available" }, null);
    expect(await service.isAppAvailable(biz.id, "connections")).toBe(true);

    await service.setBusinessAppAvailability(biz.id, "connections", null, null);
    const map = await service.effectiveAppAvailability(biz.id);
    expect(map.connections.state).toBe("coming_soon");
    expect(map.connections.source).toBe("platform");
  });

  it("an override on one business never affects another", async () => {
    const other = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other Co', $1) RETURNING id",
      [`other-${randomUUID().slice(0, 8)}`],
    );
    await service.setBusinessAppAvailability(biz.id, "sales", { state: "disabled" }, null);
    expect(await service.isAppAvailable(biz.id, "sales")).toBe(false);
    expect(await service.isAppAvailable(other.rows[0].id, "sales")).toBe(true);
  });
});

describe("the console's readouts", () => {
  it("platformAppAvailability lists every registry app and counts its overrides", async () => {
    await service.setPlatformAppAvailability("crm", { state: "maintenance", note: "  " }, null);
    await service.setBusinessAppAvailability(biz.id, "crm", { state: "available" }, null);

    const apps = await service.platformAppAvailability();
    expect(apps.map((a) => a.app).sort()).toEqual(
      ["accounting", "connections", "crm", "growth", "operations", "sales", "settings"].sort(),
    );
    const crm = apps.find((a) => a.app === "crm")!;
    expect(crm.state).toBe("maintenance");
    // A blank note is not a note: the business is shown the stock sentence.
    expect(crm.note).toBeNull();
    expect(crm.notice.length).toBeGreaterThan(0);
    expect(crm.overrideCount).toBe(1);
    expect(apps.find((a) => a.app === "sales")!.overrideCount).toBe(0);
  });

  it("businessAppAvailability shows the platform state, the override and what is in force", async () => {
    await service.setPlatformAppAvailability("growth", { state: "coming_soon" }, null);
    await service.setBusinessAppAvailability(biz.id, "growth", { state: "beta" }, null);

    const apps = await service.businessAppAvailability(biz.id);
    const growth = apps.find((a) => a.app === "growth")!;
    expect(growth.platformState).toBe("coming_soon");
    expect(growth.overridden).toBe(true);
    expect(growth.state).toBe("beta");

    const sales = apps.find((a) => a.app === "sales")!;
    expect(sales.overridden).toBe(false);
    expect(sales.platformState).toBe("available");
  });
});

describe("tenant isolation", () => {
  it("business_app_availability is RLS-protected like every other tenant table", async () => {
    const { rows } = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'business_app_availability'`,
    );
    expect(rows[0].relrowsecurity).toBe(true);
    expect(rows[0].relforcerowsecurity).toBe(true);

    const { rows: policies } = await db.query<{ policyname: string }>(
      `SELECT policyname FROM pg_policies WHERE tablename = 'business_app_availability'`,
    );
    expect(policies.map((p) => p.policyname)).toContain("tenant_isolation");
  });

  it("rejects a state outside the vocabulary at the database level", async () => {
    await expect(
      db.query(`UPDATE app_availability SET state = 'sort_of_on' WHERE app_key = 'sales'`),
    ).rejects.toThrow();
  });
});
