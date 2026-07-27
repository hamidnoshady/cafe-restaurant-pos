/**
 * Phase 17 — the interactive restore workflow for a per-tenant export
 * (scripts/restore-tenant.ts), the follow-up flagged when export shipped.
 *
 * tenant-export.integration.test.ts already proves the exported SQL is
 * restorable by applying it directly with a raw client. This file covers
 * what the restore *tool* itself adds on top of that: a dry run that
 * genuinely leaves the database untouched, `--apply` actually committing,
 * and a friendly error (not a raw constraint-violation stack) when the
 * target already has the business being restored — the one scenario the
 * tool exists specifically to catch before it does any damage.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole } from "../scripts/create-app-role";
import { extractStatements, restoreTenantExport, RestoreTenantError } from "../scripts/restore-tenant";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const APP_ROLE = "pos_restore_test_role";
const APP_PASSWORD = "restore-test-password";

let sourceDbName: string;
let cleanDbName: string;
let source: Client;
let clean: Client;
let dbLib: typeof import("../src/lib/db");
let tenantExport: typeof import("../src/lib/tenant-export");

const bizX = { id: "", locationId: "" };
let exportSql: string;

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
  sourceDbName = `pos_restoretool_src_${randomUUID().replaceAll("-", "")}`;
  cleanDbName = `pos_restoretool_dst_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${sourceDbName}"`);
    await maintenance.query(`CREATE DATABASE "${cleanDbName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(sourceDbName), quiet: true });
  await runMigrations({ databaseUrl: urlFor(cleanDbName), quiet: true });
  await createAppRole({ databaseUrl: urlFor(sourceDbName), roleName: APP_ROLE, password: APP_PASSWORD, quiet: true });

  process.env.DATABASE_URL = urlFor(sourceDbName, { name: APP_ROLE, password: APP_PASSWORD });
  dbLib = await import("../src/lib/db");
  tenantExport = await import("../src/lib/tenant-export");

  source = new Client({ connectionString: urlFor(sourceDbName) });
  await source.connect();
  clean = new Client({ connectionString: urlFor(cleanDbName) });
  await clean.connect();

  const x = await source.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Restore Co', $1) RETURNING id",
    [`restore-x-${randomUUID().slice(0, 8)}`],
  );
  bizX.id = x.rows[0].id;
  const locX = await source.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [bizX.id],
  );
  bizX.locationId = locX.rows[0].id;

  const tables = await tenantExport.exportTenantData(bizX.id);
  exportSql = tenantExport.tenantDataToSql(tables);
}, 120_000);

afterAll(async () => {
  await source?.end();
  await clean?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${sourceDbName}" WITH (FORCE)`);
    await maintenance.query(`DROP DATABASE IF EXISTS "${cleanDbName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

describe("extractStatements", () => {
  it("rejects a file that isn't shaped like a per-tenant export", () => {
    expect(() => extractStatements("SELECT 1;")).toThrow(RestoreTenantError);
  });

  it("strips the BEGIN;/COMMIT; wrapper, leaving just the INSERTs", () => {
    const body = extractStatements(exportSql);
    expect(body).toContain('INSERT INTO "businesses"');
    expect(body).not.toContain("BEGIN;");
    expect(body).not.toContain("COMMIT;");
  });
});

describe("restoreTenantExport", () => {
  it("a dry run leaves the database untouched even though every INSERT actually ran", async () => {
    const result = await restoreTenantExport(clean, exportSql, { apply: false });
    expect(result.committed).toBe(false);
    expect(result.insertCount).toBeGreaterThan(0);

    const { rows } = await clean.query("SELECT id FROM businesses WHERE id = $1", [bizX.id]);
    expect(rows).toHaveLength(0);
  });

  it("--apply commits it for real", async () => {
    const result = await restoreTenantExport(clean, exportSql, { apply: true });
    expect(result.committed).toBe(true);

    const { rows } = await clean.query<{ id: string }>("SELECT id FROM businesses WHERE id = $1", [bizX.id]);
    expect(rows).toEqual([{ id: bizX.id }]);
  });

  it("refuses with a friendly error when the target already has this business (not a raw constraint stack)", async () => {
    // `clean` now already has bizX committed from the previous test.
    await expect(restoreTenantExport(clean, exportSql, { apply: false })).rejects.toMatchObject({
      constructor: RestoreTenantError,
      message: expect.stringContaining("already has this business"),
    });

    // And the failed attempt didn't leave a half-applied transaction open —
    // the connection is still usable for an ordinary query afterward.
    const { rows } = await clean.query<{ n: string }>("SELECT count(*)::text AS n FROM businesses");
    expect(Number(rows[0].n)).toBe(1);
  });

  it("refuses against a database with no schema_migrations rows", async () => {
    const unmigratedDbName = `pos_restoretool_unmigrated_${randomUUID().replaceAll("-", "")}`;
    const maintenance = new Client({ connectionString: maintenanceUrl() });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE "${unmigratedDbName}"`);
    await maintenance.end();

    const unmigrated = new Client({ connectionString: urlFor(unmigratedDbName) });
    await unmigrated.connect();
    try {
      await expect(restoreTenantExport(unmigrated, exportSql, { apply: false })).rejects.toThrow(RestoreTenantError);
    } finally {
      await unmigrated.end();
      const m2 = new Client({ connectionString: maintenanceUrl() });
      await m2.connect();
      await m2.query(`DROP DATABASE IF EXISTS "${unmigratedDbName}" WITH (FORCE)`);
      await m2.end();
    }
  });
});
