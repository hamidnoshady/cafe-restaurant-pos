/**
 * `isSetupComplete` / `computeSetupState` decide whether a signed-in owner is
 * sent to the dashboard or back into the setup wizard, and they are called
 * from server components (`app/page.tsx`, `app/setup/*`) that only ever carry
 * `getSession()`'s `enterWith()` tenant scope. That scope can be clobbered
 * mid-request by a concurrent background tick's `.run()` (see the
 * `withTenantScope` doc comment in src/lib/auth.ts), after which every read
 * these functions make comes back empty under row-level security and a
 * *finished* business is bounced back into the wizard on every login.
 *
 * The fix is that both functions self-scope with `withTenant(businessId)`
 * (`.run()`), so the caller's ambient scope no longer matters. This test
 * reproduces the failure shape: it connects as an unprivileged role — the
 * same paranoia as tenant-isolation.integration.test.ts, because run as a
 * superuser the reads would succeed unscoped and the assertion would be
 * vacuous — and calls the functions with no ambient scope at all.
 */
import { randomUUID } from "node:crypto";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole } from "../scripts/create-app-role";
import { computeSetupState, isSetupComplete } from "../src/lib/setup-state";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const APP_ROLE = "pos_setup_complete_test_role";
const APP_PASSWORD = "setup-complete-test-password";

let databaseName: string;
let ownerClient: Client;

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

/** See pairing.integration.test.ts: db.ts caches its pool on globalThis. */
const globalForPg = globalThis as unknown as { pgPool?: Pool };

beforeAll(async () => {
  databaseName = `pos_setup_complete_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  const ownerUrl = urlFor(databaseName);
  await runMigrations({ databaseUrl: ownerUrl, quiet: true });
  await createAppRole({
    databaseUrl: ownerUrl,
    roleName: APP_ROLE,
    password: APP_PASSWORD,
    quiet: true,
  });

  ownerClient = new Client({ connectionString: ownerUrl });
  await ownerClient.connect();

  // Point db.ts's pool at this database as the UNPRIVILEGED role, so the
  // setup-state reads run under real row-level security.
  await globalForPg.pgPool?.end().catch(() => {});
  delete globalForPg.pgPool;
  process.env.DATABASE_URL = urlFor(databaseName, { name: APP_ROLE, password: APP_PASSWORD });
}, 120_000);

afterAll(async () => {
  await globalForPg.pgPool?.end().catch(() => {});
  delete globalForPg.pgPool;
  process.env.DATABASE_URL = rootDatabaseUrl;
  await ownerClient?.end();

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await maintenance.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
  } finally {
    await maintenance.end();
  }
});

/** Seed a business whose wizard progress carries exactly `steps`, and no completedAt. */
async function seedBusinessWithSteps(steps: string[]): Promise<string> {
  const slug = `wizard-${randomUUID().slice(0, 8)}`;
  const { rows } = await ownerClient.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    [`Wizard Cafe ${slug}`, slug],
  );
  const businessId = rows[0].id;

  const stepMap: Record<string, string> = {};
  for (const step of steps) stepMap[step] = "2026-01-01T00:00:00.000Z";
  await ownerClient.query(
    `INSERT INTO settings (business_id, location_id, key, value)
     VALUES ($1, NULL, 'setup.progress', $2)`,
    [businessId, JSON.stringify({ steps: stepMap, completedAt: null })],
  );
  return businessId;
}

describe("setup completeness under row-level security", () => {
  it("runs as a role that row-level security applies to", async () => {
    // If this fails, the assertions below are vacuous.
    const { rows } = await ownerClient.query<{ privileged: boolean }>(
      "SELECT (rolsuper OR rolbypassrls) AS privileged FROM pg_roles WHERE rolname = $1",
      [APP_ROLE],
    );
    expect(rows[0].privileged).toBe(false);
  });

  it("sees a finished wizard as complete with no ambient tenant scope", async () => {
    const businessId = await seedBusinessWithSteps([
      "business",
      "accounts",
      "costing",
      "tax",
      "menu",
    ]);

    // No `withTenant`/`enterTenantScope` here on purpose: this is the server-
    // component case, where only getSession()'s clobberable enterWith() scope
    // would otherwise be in force (and may already have been clobbered).
    expect(await isSetupComplete(businessId)).toBe(true);

    const state = await computeSetupState(businessId);
    expect(state.missingForCompletion).toEqual([]);
    expect(state.progress.steps.business).toBeTruthy();
    expect(state.progress.steps.menu).toBeTruthy();
  });

  it("still reports a partially-done wizard as incomplete (fails closed)", async () => {
    const businessId = await seedBusinessWithSteps(["business"]);

    expect(await isSetupComplete(businessId)).toBe(false);

    const state = await computeSetupState(businessId);
    expect(state.missingForCompletion.length).toBeGreaterThan(0);
  });

  it("treats a stamped completedAt as complete even if a step is missing", async () => {
    // The formal "finish" button records completedAt; from then on the flag,
    // not the per-step map, is what matters.
    const { rows } = await ownerClient.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Stamped Cafe', $1) RETURNING id",
      [`stamped-${randomUUID().slice(0, 8)}`],
    );
    const businessId = rows[0].id;
    await ownerClient.query(
      `INSERT INTO settings (business_id, location_id, key, value)
       VALUES ($1, NULL, 'setup.progress', $2)`,
      [
        businessId,
        JSON.stringify({ steps: { business: "2026-01-01T00:00:00.000Z" }, completedAt: "2026-01-02T00:00:00.000Z" }),
      ],
    );

    expect(await isSetupComplete(businessId)).toBe(true);
  });
});
