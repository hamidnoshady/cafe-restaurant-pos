/**
 * Phase 17 security review: `imp.grantId`'s own doc comment (auth-edge.ts)
 * always claimed it was "re-checked live on the server, never trusted
 * alone," but nothing ever called `activeGrant` outside its own definition —
 * ending or revoking a grant stamped the row without affecting the
 * already-minted session at all. `getSession()` (auth.ts) now calls
 * `activeGrant` for every session carrying an `imp` claim; this proves the
 * primitive it depends on — start/end/revoke/expiry — is correct.
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
let platformService: typeof import("../src/lib/platform-service");

const biz = { id: "" };
const admin = { id: "" };
const otherAdmin = { id: "" };

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
  databaseName = `pos_impersonation_${randomUUID().replaceAll("-", "")}`;

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
  await db.query("DELETE FROM impersonation_grants");
  await db.query("DELETE FROM users");
  await db.query("DELETE FROM businesses");
  await db.query("DELETE FROM platform_admins");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Impersonation Co', $1) RETURNING id",
    [`imp-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  await db.query(
    `INSERT INTO users (business_id, role, full_name, pin_hash, is_active) VALUES ($1, 'owner', 'Owner', 'x', true)`,
    [biz.id],
  );

  const adminRow = await db.query<{ id: string }>(
    `INSERT INTO platform_admins (email, password_hash, full_name) VALUES ('admin@example.com', 'x', 'Admin') RETURNING id`,
  );
  admin.id = adminRow.rows[0].id;

  const otherAdminRow = await db.query<{ id: string }>(
    `INSERT INTO platform_admins (email, password_hash, full_name) VALUES ('other-admin@example.com', 'x', 'Other Admin') RETURNING id`,
  );
  otherAdmin.id = otherAdminRow.rows[0].id;
});

describe("startImpersonation / activeGrant", () => {
  it("a fresh grant is live", async () => {
    const { grant } = await platformService.startImpersonation({
      adminId: admin.id,
      businessId: biz.id,
      mode: "read_only",
    });
    const live = await platformService.activeGrant(admin.id, biz.id);
    expect(live?.id).toBe(grant.id);
  });

  it("does not match a different admin or a different business", async () => {
    await platformService.startImpersonation({ adminId: admin.id, businessId: biz.id, mode: "read_only" });
    expect(await platformService.activeGrant(otherAdmin.id, biz.id)).toBeNull();
    expect(await platformService.activeGrant(admin.id, randomUUID())).toBeNull();
  });
});

describe("endImpersonation — the admin leaving on their own", () => {
  it("makes activeGrant stop returning the grant immediately", async () => {
    const { grant } = await platformService.startImpersonation({
      adminId: admin.id,
      businessId: biz.id,
      mode: "full",
    });
    expect(await platformService.activeGrant(admin.id, biz.id)).not.toBeNull();

    await platformService.endImpersonation(grant.id, admin.id);
    expect(await platformService.activeGrant(admin.id, biz.id)).toBeNull();
  });

  it("another admin cannot end someone else's grant this way", async () => {
    const { grant } = await platformService.startImpersonation({
      adminId: admin.id,
      businessId: biz.id,
      mode: "full",
    });
    await platformService.endImpersonation(grant.id, otherAdmin.id);
    // Still live: endImpersonation's WHERE clause requires the same admin.
    expect(await platformService.activeGrant(admin.id, biz.id)).not.toBeNull();
  });
});

describe("revokeImpersonation — the kill switch", () => {
  it("makes activeGrant stop returning the grant immediately, same as ending it", async () => {
    const { grant } = await platformService.startImpersonation({
      adminId: admin.id,
      businessId: biz.id,
      mode: "full",
    });
    expect(await platformService.activeGrant(admin.id, biz.id)).not.toBeNull();

    await platformService.revokeImpersonation(grant.id, otherAdmin.id);
    expect(await platformService.activeGrant(admin.id, biz.id)).toBeNull();
  });

  it("a revoked grant cannot also be ended, and vice versa", async () => {
    const { grant } = await platformService.startImpersonation({
      adminId: admin.id,
      businessId: biz.id,
      mode: "full",
    });
    await platformService.revokeImpersonation(grant.id, otherAdmin.id);

    const { rows } = await db.query<{ ended_at: string | null; revoked_at: string | null }>(
      "SELECT ended_at, revoked_at FROM impersonation_grants WHERE id = $1",
      [grant.id],
    );
    expect(rows[0].revoked_at).not.toBeNull();

    // endImpersonation's WHERE excludes already-revoked rows, so this is a no-op.
    await platformService.endImpersonation(grant.id, admin.id);
    const after = await db.query<{ ended_at: string | null }>(
      "SELECT ended_at FROM impersonation_grants WHERE id = $1",
      [grant.id],
    );
    expect(after.rows[0].ended_at).toBeNull();
  });
});

describe("expiry", () => {
  it("an expired grant is not live even though never explicitly ended or revoked", async () => {
    const { grant } = await platformService.startImpersonation({
      adminId: admin.id,
      businessId: biz.id,
      mode: "read_only",
    });
    await db.query("UPDATE impersonation_grants SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      grant.id,
    ]);
    expect(await platformService.activeGrant(admin.id, biz.id)).toBeNull();
  });
});
