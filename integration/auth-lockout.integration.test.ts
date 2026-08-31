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
let lockoutService: typeof import("../src/lib/login-lockout-service");
let lockoutPolicy: typeof import("../src/lib/login-lockout");

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
  databaseName = `pos_auth_lockout_${randomUUID().replaceAll("-", "")}`;

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
  lockoutService = await import("../src/lib/login-lockout-service");
  lockoutPolicy = await import("../src/lib/login-lockout");

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
  await db.query("TRUNCATE TABLE auth_login_attempts CASCADE");
});

describe("auth-lockout integration", () => {
  it("N failures lock, a success clears the streak, realms don't share a bucket", async () => {
    const { checkAuthLockout, recordAuthFailure, recordAuthSuccess } = lockoutService;
    const { PLATFORM_LOCKOUT_POLICY, PASSWORD_LOCKOUT_POLICY } = lockoutPolicy;
    const email = "test@example.com";

    // Fail 3 times in platform_admin
    await recordAuthFailure("platform_admin", email);
    await recordAuthFailure("platform_admin", email);
    await recordAuthFailure("platform_admin", email);

    const platformStatus = await checkAuthLockout("platform_admin", email, PLATFORM_LOCKOUT_POLICY);
    expect(platformStatus.locked).toBe(true);

    // Tenant password should not share the bucket
    const tenantStatus = await checkAuthLockout("tenant_password", email, PASSWORD_LOCKOUT_POLICY);
    expect(tenantStatus.locked).toBe(false);

    // Success clears the streak
    await recordAuthSuccess("platform_admin", email);
    const platformStatus2 = await checkAuthLockout("platform_admin", email, PLATFORM_LOCKOUT_POLICY);
    expect(platformStatus2.locked).toBe(false);
  });

  it("checkAuthLockout runs against the real table and counts only failures", async () => {
    // The unit test pins the SQL text; this pins that the SQL is *valid*
    // against migration 0070. The lockout is consulted on the successful-
    // password path of all three login routes, so a column that does not
    // exist here is an HTTP 500 on every correct credential.
    const { checkAuthLockout, recordAuthFailure, clearAuthLockout } = lockoutService;
    const { PASSWORD_LOCKOUT_POLICY } = lockoutPolicy;
    const email = "column-check@example.com";

    const clean = await checkAuthLockout("tenant_password", email, PASSWORD_LOCKOUT_POLICY);
    expect(clean).toEqual({ locked: false, failedCount: 0, lockedUntil: null });

    for (let i = 0; i < PASSWORD_LOCKOUT_POLICY.threshold - 1; i += 1) {
      await recordAuthFailure("tenant_password", email);
    }
    const belowThreshold = await checkAuthLockout("tenant_password", email, PASSWORD_LOCKOUT_POLICY);
    expect(belowThreshold.locked).toBe(false);
    expect(belowThreshold.failedCount).toBe(PASSWORD_LOCKOUT_POLICY.threshold - 1);

    await recordAuthFailure("tenant_password", email);
    const atThreshold = await checkAuthLockout("tenant_password", email, PASSWORD_LOCKOUT_POLICY);
    expect(atThreshold.locked).toBe(true);
    expect(atThreshold.lockedUntil).not.toBeNull();

    // An explicit unlock breaks the streak the same way a success does.
    await clearAuthLockout("tenant_password", email);
    const unlocked = await checkAuthLockout("tenant_password", email, PASSWORD_LOCKOUT_POLICY);
    expect(unlocked.locked).toBe(false);
  });

  it("stores a peppered identity key, never the raw email", async () => {
    const { recordAuthFailure } = lockoutService;
    const email = "pepper@example.com";
    await recordAuthFailure("directory", email);

    const { rows } = await dbLib.query<{ identity_key: string; outcome: string }>(
      `SELECT identity_key, outcome FROM auth_login_attempts WHERE realm = 'directory'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("failed");
    expect(rows[0].identity_key).not.toContain(email);
    expect(rows[0].identity_key).toMatch(/^[0-9a-f]{64}$/);
  });
});
