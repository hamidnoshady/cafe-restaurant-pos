/**
 * Registered-terminal lifecycle against the real schema.
 *
 * This keeps the manager UI's assumptions honest: it needs a recognisable
 * branch name, a non-mutating current-device lookup, truthful active-session
 * impact before revocation, and safe rename/revoke operations scoped to the
 * business that owns the row.
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
let devices: typeof import("../src/lib/device-service");

const alpha = { businessId: "", locationId: "", ownerId: "", cashierId: "" };
const beta = { businessId: "", locationId: "", ownerId: "", cashierId: "" };

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

async function seedBusiness(name: string, slug: string) {
  const business = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    [name, slug],
  );
  const businessId = business.rows[0].id;
  const location = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, $2) RETURNING id",
    [businessId, `${name} مرکزی`],
  );
  const locationId = location.rows[0].id;
  const owner = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, password_hash)
     VALUES ($1, 'owner', $2, 'test') RETURNING id`,
    [businessId, `${name} مالک`],
  );
  const cashier = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, location_id, role, full_name, pin_hash)
     VALUES ($1, $2, 'cashier', $3, 'test') RETURNING id`,
    [businessId, locationId, `${name} صندوق‌دار`],
  );
  await db.query("INSERT INTO employees (id, business_id) VALUES ($1, $2)", [cashier.rows[0].id, businessId]);
  return { businessId, locationId, ownerId: owner.rows[0].id, cashierId: cashier.rows[0].id };
}

function asBusiness<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(businessId, fn);
}

beforeAll(async () => {
  databaseName = `pos_device_binding_${randomUUID().replaceAll("-", "")}`;
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
  devices = await import("../src/lib/device-service");
  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.closeDatabasePool().catch(() => {});
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
  await db.query("DELETE FROM businesses");
  Object.assign(alpha, await seedBusiness("آلفا", `alpha-${randomUUID().slice(0, 8)}`));
  Object.assign(beta, await seedBusiness("بتا", `beta-${randomUUID().slice(0, 8)}`));
});

describe("registered device lifecycle", () => {
  it("shows its branch and active-session impact, identifies the current token without touching activity, renames, and revokes", async () => {
    const paired = await asBusiness(alpha.businessId, () =>
      devices.pairDevice(alpha.businessId, alpha.locationId, alpha.ownerId, "  صندوق اصلی  "),
    );
    expect(paired.device.label).toBe("صندوق اصلی");
    expect(paired.device.locationName).toBe("آلفا مرکزی");

    const beforeLookup = await db.query<{ last_seen_at: Date | null }>(
      "SELECT last_seen_at FROM pos_devices WHERE id = $1",
      [paired.device.id],
    );
    expect(
      await asBusiness(alpha.businessId, () => devices.findActiveDeviceId(paired.token, alpha.businessId)),
    ).toBe(paired.device.id);
    const afterLookup = await db.query<{ last_seen_at: Date | null }>(
      "SELECT last_seen_at FROM pos_devices WHERE id = $1",
      [paired.device.id],
    );
    expect(afterLookup.rows[0].last_seen_at).toEqual(beforeLookup.rows[0].last_seen_at);

    await db.query(
      `INSERT INTO employee_sessions (employee_id, business_id, location_id, token_hash, device_id, expires_at)
       VALUES ($1, $2, $3, repeat('a', 64), $4, now() + interval '1 day')`,
      [alpha.cashierId, alpha.businessId, alpha.locationId, paired.device.id],
    );
    const listed = await asBusiness(alpha.businessId, () => devices.listDevices(alpha.businessId));
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: paired.device.id,
      locationName: "آلفا مرکزی",
      activeSessionCount: 1,
      revokedAt: null,
    });

    const renamed = await asBusiness(alpha.businessId, () =>
      devices.renameDevice(paired.device.id, alpha.businessId, alpha.ownerId, "صندوق سالن"),
    );
    expect(renamed.label).toBe("صندوق سالن");
    expect(
      await asBusiness(alpha.businessId, () => devices.findActiveDeviceId(paired.token, alpha.businessId)),
    ).toBe(paired.device.id);

    await asBusiness(alpha.businessId, () =>
      devices.revokeDevice(paired.device.id, alpha.businessId, alpha.ownerId),
    );
    expect(
      await asBusiness(alpha.businessId, () => devices.findActiveDeviceId(paired.token, alpha.businessId)),
    ).toBeNull();

    const revoked = await asBusiness(alpha.businessId, () => devices.listDevices(alpha.businessId));
    expect(revoked[0]).toMatchObject({
      label: "صندوق سالن",
      activeSessionCount: 0,
    });
    expect(revoked[0].revokedAt).not.toBeNull();

    const session = await db.query<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM employee_sessions WHERE device_id = $1",
      [paired.device.id],
    );
    expect(session.rows[0].revoked_at).not.toBeNull();

    const audit = await db.query<{ action: string }>(
      "SELECT action FROM audit_log WHERE business_id = $1 AND entity_id = $2 ORDER BY id",
      [alpha.businessId, paired.device.id],
    );
    expect(audit.rows.map((entry) => entry.action)).toEqual([
      "device.paired",
      "device.renamed",
      "device.revoked",
    ]);
  });

  it("never resolves or mutates a device belonging to another business", async () => {
    const paired = await asBusiness(alpha.businessId, () =>
      devices.pairDevice(alpha.businessId, alpha.locationId, alpha.ownerId, "صندوق آلفا"),
    );

    expect(
      await asBusiness(beta.businessId, () => devices.findActiveDeviceId(paired.token, beta.businessId)),
    ).toBeNull();
    await expect(
      asBusiness(beta.businessId, () =>
        devices.renameDevice(paired.device.id, beta.businessId, beta.ownerId, "نباید تغییر کند"),
      ),
    ).rejects.toMatchObject({ message: "device_not_found", status: 404 });
    await expect(
      asBusiness(beta.businessId, () => devices.revokeDevice(paired.device.id, beta.businessId, beta.ownerId)),
    ).rejects.toMatchObject({ message: "device_not_found", status: 404 });

    const stillActive = await asBusiness(alpha.businessId, () => devices.listDevices(alpha.businessId));
    expect(stillActive[0]).toMatchObject({ label: "صندوق آلفا", revokedAt: null });
  });
});
