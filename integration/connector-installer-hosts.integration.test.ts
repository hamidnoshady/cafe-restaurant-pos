/**
 * The print connector installer asks one question of the tenant model:
 * "every host label that legitimately names this business" — the current
 * subdomain plus rename aliases. Those labels become the connector's
 * allowed-origin set, so the answer must come from the database and must
 * never leak across businesses. `listBusinessHostLabels` is that lookup.
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
let hostResolution: typeof import("../src/lib/host-resolution");
let tenantContext: typeof import("../src/lib/tenant-context");

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

async function createBusiness(name: string, subdomain: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, subdomain) VALUES ($1, $2, $3) RETURNING id",
    [name, `${subdomain}-slug`, subdomain],
  );
  return rows[0].id;
}

beforeAll(async () => {
  databaseName = `pos_connector_hosts_${randomUUID().replaceAll("-", "")}`;

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
  hostResolution = await import("../src/lib/host-resolution");
  tenantContext = await import("../src/lib/tenant-context");

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

describe("listBusinessHostLabels", () => {
  it("returns the current subdomain plus every alias, ordered", async () => {
    const businessId = await createBusiness("کافه زنیزیبا", "zaniziba");
    await db.query("INSERT INTO business_subdomain_aliases (business_id, alias) VALUES ($1, $2)", [businessId, "zani-old"]);
    // A beat apart so created_at ordering is meaningful.
    await db.query("SELECT pg_sleep(0.01)");
    await db.query("INSERT INTO business_subdomain_aliases (business_id, alias) VALUES ($1, $2)", [businessId, "zani-older"]);

    const labels = await tenantContext.runInTenantScope(
      tenantContext.businessScope(businessId, null, "user-1"),
      () => hostResolution.listBusinessHostLabels(businessId),
    );

    expect(labels).toEqual({ subdomain: "zaniziba", aliases: ["zani-old", "zani-older"] });
  });

  it("never borrows another business's labels", async () => {
    const first = await createBusiness("first", "first-biz");
    const second = await createBusiness("second", "second-biz");
    await db.query("INSERT INTO business_subdomain_aliases (business_id, alias) VALUES ($1, $2)", [second, "second-old"]);

    const labels = await tenantContext.runInTenantScope(
      tenantContext.businessScope(first, null, "user-1"),
      () => hostResolution.listBusinessHostLabels(first),
    );

    expect(labels).toEqual({ subdomain: "first-biz", aliases: [] });
  });

  it("answers null for a business that does not exist", async () => {
    const labels = await tenantContext.runInTenantScope(tenantContext.NO_SCOPE, () =>
      hostResolution.listBusinessHostLabels(randomUUID()),
    );
    expect(labels).toBeNull();
  });
});
