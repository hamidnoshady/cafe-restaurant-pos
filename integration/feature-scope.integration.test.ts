/**
 * Regression test for the bug behind "the AI assistant and the online-store
 * menu entries are in the sidebar, but opening either bounces me back to the
 * dashboard".
 *
 * `business_features` is RLS-protected; `feature_flags` is not. So a read of
 * `effectiveFeatures` that runs with no tenant scope does not fail — it
 * quietly returns the catalogue with every per-business override missing, and
 * resolves each flag to `default_enabled`. For the eight default-ON flags that
 * is indistinguishable from working. For the two default-OFF ones
 * (`ai_assistant`, `integrations`) it silently revokes the entitlement of every
 * business that paid for it.
 *
 * Server components are exactly where that happened: they only ever had the
 * `enterWith()` scope `getSession()` sets, which any concurrent
 * `AsyncLocalStorage.run()` elsewhere in the process drops (see the
 * `withTenantScope` doc comment in src/lib/auth.ts). The dashboard layout
 * wraps its own read in `withTenant`, so the nav entry rendered; the page's
 * `requireFeatureForPage` did not, so it redirected.
 *
 * Like tenant-isolation.integration.test.ts, this connects as a purpose-made
 * **unprivileged role** — under the superuser the compose file and CI both
 * hand out, RLS is a no-op and this test would pass vacuously against the
 * broken code.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole } from "../scripts/create-app-role";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const APP_ROLE = "pos_feature_scope_role";
const APP_PASSWORD = "feature-scope-password";

let databaseName: string;
let ownerClient: Client;
let dbLib: typeof import("../src/lib/db");
let features: typeof import("../src/lib/features");
let industryGuard: typeof import("../src/lib/industry-guard");

const biz = { id: "" };

function urlFor(database: string, user?: { name: string; password: string }): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_feature_scope_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  await createAppRole({
    databaseUrl: urlFor(databaseName),
    roleName: APP_ROLE,
    password: APP_PASSWORD,
    quiet: true,
  });

  ownerClient = new Client({ connectionString: urlFor(databaseName) });
  await ownerClient.connect();

  const bizRow = await ownerClient.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Scoped Co', $1, 'food_service') RETURNING id",
    [`scoped-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  // Both default-OFF flags switched ON for this business — the entitled state
  // whose overrides an unscoped read loses.
  for (const flag of ["ai_assistant", "integrations"]) {
    await ownerClient.query(
      "INSERT INTO business_features (business_id, flag_key, enabled) VALUES ($1, $2, true)",
      [biz.id, flag],
    );
  }

  // The app pool must be the unprivileged role, and must be built after
  // DATABASE_URL points at it (src/lib/db.ts reads it once, lazily).
  process.env.DATABASE_URL = urlFor(databaseName, { name: APP_ROLE, password: APP_PASSWORD });
  dbLib = await import("../src/lib/db");
  features = await import("../src/lib/features");
  industryGuard = await import("../src/lib/industry-guard");
}, 120_000);

afterAll(async () => {
  await ownerClient?.end();
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

describe("feature and industry reads under RLS", () => {
  it("sees a business's overrides with no ambient tenant scope — the server-component case", async () => {
    // No withTenant() here on purpose: this is a page whose enterWith() scope
    // has been dropped by a concurrent run(). Before the fix both of these
    // came back false, which is what redirected an entitled business away from
    // /dashboard/ai and /dashboard/integrations.
    expect(await features.isFeatureEnabled(biz.id, "ai_assistant")).toBe(true);
    expect(await features.isFeatureEnabled(biz.id, "integrations")).toBe(true);

    const effective = await features.effectiveFeatures(biz.id);
    expect(effective.ai_assistant).toBe(true);
    expect(effective.integrations).toBe(true);
    // Default-ON flags with no override are unaffected either way.
    expect(effective.inventory).toBe(true);
  });

  it("keeps answering correctly when another business's scope is the ambient one", async () => {
    const other = await ownerClient.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other Co', $1) RETURNING id",
      [`other-${randomUUID().slice(0, 8)}`],
    );
    const otherId = other.rows[0].id;

    await dbLib.withTenant(otherId, async () => {
      expect(await features.isFeatureEnabled(biz.id, "ai_assistant")).toBe(true);
      expect(await features.isFeatureEnabled(otherId, "ai_assistant")).toBe(false);
    });
  });

  it("resolves a business's industry with no ambient scope — the same failure on the industry pages", async () => {
    expect(await industryGuard.getBusinessIndustry(biz.id)).toBe("food_service");
    expect(await industryGuard.isModuleEnabled(biz.id, "kitchen")).toBe(true);
  });
});
