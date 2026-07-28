/**
 * Super-admin business management — real-database regression coverage.
 *
 * A reset must remove every tenant-owned record without touching another
 * business, while retaining exactly one usable owner identity and starting the
 * target tenant at the first-run setup state.
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
let setupState: typeof import("../src/lib/setup-state");

interface SeededBusiness {
  id: string;
  locationId: string;
  ownerId: string;
  platformUserId: string;
  name: string;
  slug: string;
}

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
  databaseName = `pos_platform_business_${randomUUID().replaceAll("-", "")}`;

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
  setupState = await import("../src/lib/setup-state");

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

async function seedBusiness(name: string, slug: string): Promise<SeededBusiness> {
  const email = `${slug}@example.com`;
  const identity = await db.query<{ id: string }>(
    `INSERT INTO platform_users (email, password_hash, full_name)
     VALUES ($1, 'hash', $2)
     RETURNING id`,
    [email, `${name} Owner`],
  );
  const platformUserId = identity.rows[0].id;

  const business = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, plan, timezone)
     VALUES ($1, $2, 'business', 'Asia/Tehran')
     RETURNING id`,
    [name, slug],
  );
  const businessId = business.rows[0].id;

  const location = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name, address, phone)
     VALUES ($1, 'Original branch', 'Old address', '02100000000')
     RETURNING id`,
    [businessId],
  );
  const locationId = location.rows[0].id;

  const owner = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, platform_user_id, role, full_name, email)
     VALUES ($1, $2, 'owner', $3, $4)
     RETURNING id`,
    [businessId, platformUserId, `${name} Owner`, email],
  );
  const ownerId = owner.rows[0].id;
  await db.query(`INSERT INTO user_locations (user_id, location_id) VALUES ($1, $2)`, [
    ownerId,
    locationId,
  ]);

  const category = await db.query<{ id: string }>(
    `INSERT INTO menu_categories (location_id, name) VALUES ($1, 'Drinks') RETURNING id`,
    [locationId],
  );
  await db.query(
    `INSERT INTO menu_items (location_id, category_id, name, price)
     VALUES ($1, $2, 'Latte', 100000)`,
    [locationId, category.rows[0].id],
  );
  await db.query(
    `INSERT INTO orders (location_id, order_number, type, status, total)
     VALUES ($1, 1, 'takeaway', 'completed', 100000)`,
    [locationId],
  );
  await db.query(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1000', 'Cash', 'asset')`,
    [businessId],
  );
  await db.query(
    `INSERT INTO settings (business_id, location_id, key, value)
     VALUES ($1, NULL, 'wizard.progress', '{"steps":{"business":"done"},"completedAt":"2026-01-01T00:00:00.000Z"}')`,
    [businessId],
  );
  await db.query(
    `INSERT INTO business_features (business_id, flag_key, enabled)
     VALUES ($1, 'inventory', false)`,
    [businessId],
  );
  await db.query(
    `INSERT INTO users (business_id, role, full_name, pin_hash)
     VALUES ($1, 'cashier', 'Temporary cashier', 'hash')`,
    [businessId],
  );

  return { id: businessId, locationId, ownerId, platformUserId, name, slug };
}

beforeEach(async () => {
  await db.query("DELETE FROM businesses");
  await db.query("DELETE FROM platform_users");
});

describe("super-admin business metadata", () => {
  it("updates only the editable business metadata", async () => {
    const business = await seedBusiness("Edit Cafe", `edit-${randomUUID().slice(0, 8)}`);

    const updated = await platformService.updateBusiness(business.id, {
      name: "Edited Cafe",
      timezone: "Europe/Berlin",
    });

    expect(updated).toMatchObject({
      id: business.id,
      name: "Edited Cafe",
      slug: business.slug,
      timezone: "Europe/Berlin",
    });
    const { rows } = await db.query<{ name: string; timezone: string }>(
      `SELECT name, timezone FROM businesses WHERE id = $1`,
      [business.id],
    );
    expect(rows[0]).toEqual({ name: "Edited Cafe", timezone: "Europe/Berlin" });
  });
});

describe("resetBusiness", () => {
  it("clears one tenant completely, preserves its owner identity and plan, and leaves another tenant untouched", async () => {
    const target = await seedBusiness("Reset Cafe", `reset-${randomUUID().slice(0, 8)}`);
    const neighbour = await seedBusiness("Neighbour Cafe", `neighbour-${randomUUID().slice(0, 8)}`);

    await platformService.resetBusiness(target.id);

    const { rows: resetBusinesses } = await db.query<{
      id: string;
      name: string;
      slug: string;
      plan: string;
      timezone: string;
      status: string;
    }>(
      `SELECT id, name, slug::text AS slug, plan, timezone, status::text AS status
         FROM businesses
        WHERE id = $1`,
      [target.id],
    );
    expect(resetBusinesses).toEqual([
      {
        id: target.id,
        name: target.name,
        slug: target.slug,
        plan: "business",
        timezone: "Asia/Tehran",
        status: "active",
      },
    ]);

    const { rows: resetLocationRows } = await db.query<{ id: string; name: string; address: string | null }>(
      `SELECT id, name, address FROM locations WHERE business_id = $1`,
      [target.id],
    );
    expect(resetLocationRows).toHaveLength(1);
    expect(resetLocationRows[0]).toMatchObject({ name: "شعبه مرکزی", address: null });
    expect(resetLocationRows[0].id).not.toBe(target.locationId);

    const { rows: resetMembers } = await db.query<{
      id: string;
      platform_user_id: string;
      role: string;
      full_name: string;
    }>(
      `SELECT id, platform_user_id, role::text AS role, full_name
         FROM users
        WHERE business_id = $1`,
      [target.id],
    );
    expect(resetMembers).toEqual([
      {
        id: expect.any(String),
        platform_user_id: target.platformUserId,
        role: "owner",
        full_name: "Reset Cafe Owner",
      },
    ]);
    expect(resetMembers[0].id).not.toBe(target.ownerId);

    const ownerIdentity = await db.query(`SELECT 1 FROM platform_users WHERE id = $1`, [
      target.platformUserId,
    ]);
    expect(ownerIdentity.rowCount).toBe(1);

    for (const table of ["settings", "accounts", "business_features"] as const) {
      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${table} WHERE business_id = $1`,
        [target.id],
      );
      expect(rows[0].n, table).toBe("0");
    }

    for (const table of ["menu_categories", "menu_items", "orders"] as const) {
      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${table} WHERE location_id = $1`,
        [resetLocationRows[0].id],
      );
      expect(rows[0].n, table).toBe("0");
    }

    const state = await dbLib.withTenant(target.id, () => setupState.computeSetupState(target.id));
    expect(state.progress.completedAt).toBeNull();
    expect(state.counts).toMatchObject({ accounts: 0, users: 1, categories: 0, items: 0 });

    const neighbourData = await db.query<{ menu_items: string; orders: string; users: string }>(
      `SELECT
         (SELECT count(*) FROM menu_items WHERE location_id = $1)::text AS menu_items,
         (SELECT count(*) FROM orders WHERE location_id = $1)::text AS orders,
         (SELECT count(*) FROM users WHERE business_id = $2)::text AS users`,
      [neighbour.locationId, neighbour.id],
    );
    expect(neighbourData.rows[0]).toEqual({ menu_items: "1", orders: "1", users: "2" });
  });
});
