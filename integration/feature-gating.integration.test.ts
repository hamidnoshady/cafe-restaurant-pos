/**
 * Phase 17 scope: "Flag-driven gating — the feature flags Phase 12 modelled
 * and Phase 15 administers actually gate UI and API." Phase 15 built the
 * write side (platform-service.ts's setBusinessFeature); this proves the
 * read side (features.ts's effectiveFeatures/isFeatureEnabled) resolves a
 * per-business override against the catalogue default correctly, and that
 * clearing an override falls back to the default — the exact round trip the
 * platform console's toggle and every gated route/page depend on.
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
let features: typeof import("../src/lib/features");
let platformService: typeof import("../src/lib/platform-service");

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
  databaseName = `pos_features_${randomUUID().replaceAll("-", "")}`;

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
  features = await import("../src/lib/features");
  platformService = await import("../src/lib/platform-service");

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
  await db.query("DELETE FROM business_features");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Features Co', $1) RETURNING id",
    [`features-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;
});

describe("effectiveFeatures / isFeatureEnabled", () => {
  it("resolves to the catalogue default with no override", async () => {
    const effective = await features.effectiveFeatures(biz.id);
    expect(effective.inventory).toBe(true);
    expect(effective.ai_assistant).toBe(false);
    expect(await features.isFeatureEnabled(biz.id, "inventory")).toBe(true);
    expect(await features.isFeatureEnabled(biz.id, "ai_assistant")).toBe(false);
  });

  it("a per-business override disables a default-on flag", async () => {
    await platformService.setBusinessFeature(biz.id, "inventory", false);
    expect(await features.isFeatureEnabled(biz.id, "inventory")).toBe(false);
    const effective = await features.effectiveFeatures(biz.id);
    expect(effective.inventory).toBe(false);
  });

  it("a per-business override enables a default-off flag", async () => {
    await platformService.setBusinessFeature(biz.id, "ai_assistant", true);
    expect(await features.isFeatureEnabled(biz.id, "ai_assistant")).toBe(true);
  });

  it("clearing an override (enabled: null) falls back to the catalogue default", async () => {
    await platformService.setBusinessFeature(biz.id, "inventory", false);
    expect(await features.isFeatureEnabled(biz.id, "inventory")).toBe(false);

    await platformService.setBusinessFeature(biz.id, "inventory", null);
    expect(await features.isFeatureEnabled(biz.id, "inventory")).toBe(true);
  });

  it("an override on one business never affects another", async () => {
    const other = await db.query<{ id: string }>("INSERT INTO businesses (name, slug) VALUES ('Other Co', $1) RETURNING id", [
      `other-${randomUUID().slice(0, 8)}`,
    ]);
    await platformService.setBusinessFeature(biz.id, "inventory", false);
    expect(await features.isFeatureEnabled(biz.id, "inventory")).toBe(false);
    expect(await features.isFeatureEnabled(other.rows[0].id, "inventory")).toBe(true);
  });
});
