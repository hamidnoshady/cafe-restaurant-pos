/**
 * Phase 24 Wave 3 — field-level encryption at rest, against a real database.
 *
 * Three things are proved here, and only the first is about cryptography:
 *
 *  1. **The registry matches the schema.** `src/lib/encrypted-columns.ts` is
 *     asserted against `information_schema.columns`, the same mechanism
 *     `tenant-isolation.integration.test.ts` uses against `pg_policy`. A
 *     migration that drops an `_enc` column out from under the services, or
 *     adds a new plaintext PII column to `customers`/`reservations` without
 *     registering it, fails here instead of shipping.
 *  2. **The services actually encrypt.** A customer written through
 *     `customers-service.ts` is unreadable in the raw row and readable through
 *     the service, and exact-match phone lookup still works through the blind
 *     index.
 *  3. **The backfill is idempotent and resumable**, and the stale-ciphertext
 *     trigger from 0125 holds even for a writer that knows nothing about
 *     encryption.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let dbName: string;
let raw: Client; // superuser connection, for looking at what is really stored
let dbLib: typeof import("../src/lib/db");
let customers: typeof import("../src/lib/customers-service");
let backfill: typeof import("../scripts/encrypt-fields");
let masterKey: typeof import("../src/lib/master-key");
let businessKeys: typeof import("../src/lib/business-keys");

const biz = { id: "", locationId: "" };

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
  dbName = `pos_fieldenc_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(dbName), quiet: true });

  // The KEK has to exist before any module memoises its absence.
  process.env.POS_MASTER_KEY = randomBytes(32).toString("base64");
  delete process.env.POS_MASTER_PASSPHRASE;
  process.env.DATABASE_URL = urlFor(dbName);

  dbLib = await import("../src/lib/db");
  masterKey = await import("../src/lib/master-key");
  businessKeys = await import("../src/lib/business-keys");
  customers = await import("../src/lib/customers-service");
  backfill = await import("../scripts/encrypt-fields");
  masterKey.resetMasterKeyCache();

  raw = new Client({ connectionString: urlFor(dbName) });
  await raw.connect();

  const b = await raw.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Crypto Co', $1) RETURNING id",
    [`crypto-${randomUUID().slice(0, 8)}`],
  );
  biz.id = b.rows[0].id;
  const loc = await raw.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = loc.rows[0].id;
}, 120_000);

afterAll(async () => {
  await raw?.end();
  await dbLib?.getPool().end().catch(() => {});
  delete process.env.POS_MASTER_KEY;
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

describe("the encrypted-column registry matches the live schema", () => {
  it("every registered ciphertext and blind-index column exists with the right type", async () => {
    const { encryptedPhysicalColumns, ENCRYPTED_TABLES } = await import("../src/lib/encrypted-columns");
    const { rows } = await raw.query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public'`,
    );
    const actual = new Map(rows.map((r) => [`${r.table_name}.${r.column_name}`, r.data_type]));

    for (const { table, column, dataType } of encryptedPhysicalColumns()) {
      expect(actual.get(`${table}.${column}`), `${table}.${column} is registered but missing`).toBe(dataType);
    }
    // And the plaintext twin each one shadows, for as long as step 3 of the
    // migration has not dropped it.
    for (const [table, spec] of Object.entries(ENCRYPTED_TABLES)) {
      for (const col of spec.columns) {
        expect(actual.has(`${table}.${col.column}`), `${table}.${col.column} is registered but missing`).toBe(true);
      }
    }
  });

  it("no unregistered PII column has appeared on an encrypted table", async () => {
    // The point of the registry: a future migration adding
    // `customers.secondary_phone` should fail here rather than quietly
    // shipping a plaintext phone number.
    const { ENCRYPTED_TABLES } = await import("../src/lib/encrypted-columns");
    const PII_NAME = /(phone|address|note)/;
    /** Registered, derived, or deliberately-plaintext columns. */
    const ALLOWED: Record<string, string[]> = {
      // The canonical +98… form (0118). Plaintext for now because duplicate
      // detection and segment resolution self-join on it; `phone_bidx` is its
      // designated replacement at step 3, when the plaintext columns go.
      customers: ["phone_e164"],
      reservations: ["note"],
    };

    for (const [table, spec] of Object.entries(ENCRYPTED_TABLES)) {
      const registered = new Set(
        spec.columns.flatMap((c) => [c.column, c.encColumn, c.bidxColumn].filter(Boolean) as string[]),
      );
      const { rows } = await raw.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      );
      const unregistered = rows
        .map((r) => r.column_name)
        .filter((c) => PII_NAME.test(c) && !registered.has(c) && !(ALLOWED[table] ?? []).includes(c));
      expect(unregistered, `unregistered PII-shaped column(s) on ${table}`).toEqual([]);
    }
  });

  it("business_encryption_keys exists, is RLS-protected, and is keyed per business", async () => {
    const { rows: policies } = await raw.query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'business_encryption_keys'`,
    );
    expect(policies[0]?.relrowsecurity).toBe(true);

    const { rows: keyed } = await raw.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_constraint
        WHERE conrelid = 'business_encryption_keys'::regclass AND contype IN ('p', 'u')`,
    );
    expect(Number(keyed[0].count)).toBeGreaterThan(0);
  });
});

describe("per-business keys", () => {
  it("mints one key and reuses it", async () => {
    const first = await businessKeys.getBusinessDek(biz.id);
    businessKeys.clearBusinessDekCache();
    const second = await businessKeys.getBusinessDek(biz.id);
    expect(first).not.toBeNull();
    expect(first!.equals(second!)).toBe(true);

    const { rows } = await raw.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM business_encryption_keys WHERE business_id = $1",
      [biz.id],
    );
    expect(rows[0].count).toBe("1");
  });

  it("stores the key wrapped, never in the clear", async () => {
    const dek = (await businessKeys.getBusinessDek(biz.id))!;
    const { rows } = await raw.query<{ wrapped_dek: Buffer }>(
      "SELECT wrapped_dek FROM business_encryption_keys WHERE business_id = $1",
      [biz.id],
    );
    const wrapped = rows[0].wrapped_dek;
    expect(wrapped.includes(dek)).toBe(false);
    expect(wrapped.subarray(0, 7).toString("latin1")).toBe("POSKEK1");
  });

  it("gives two businesses different keys", async () => {
    const other = await raw.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other Co', $1) RETURNING id",
      [`crypto-other-${randomUUID().slice(0, 8)}`],
    );
    const a = await businessKeys.getBusinessDek(biz.id);
    const b = await businessKeys.getBusinessDek(other.rows[0].id);
    expect(a!.equals(b!)).toBe(false);
  });
});

describe("customers-service reads and writes through the ciphertext", () => {
  it("stores the phone, address and notes encrypted, and reads them back in the clear", async () => {
    const created = await dbLib.withTenant(biz.id, () =>
      customers.createCustomer(biz.id, {
        name: "زهرا محمدی",
        phone: "09121234567",
        address: "تهران، خیابان ولیعصر",
        notes: "همیشه بدون شکر",
      }),
    );
    expect(created.phone).toBe("09121234567");
    expect(created.address).toBe("تهران، خیابان ولیعصر");

    const { rows } = await raw.query<{
      phone_enc: Buffer | null;
      phone_bidx: string | null;
      address_enc: Buffer | null;
      notes_enc: Buffer | null;
    }>("SELECT phone_enc, phone_bidx, address_enc, notes_enc FROM customers WHERE id = $1", [created.id]);
    expect(rows[0].phone_enc).not.toBeNull();
    expect(rows[0].phone_enc!.subarray(0, 7).toString("latin1")).toBe("POSFLD1");
    expect(rows[0].phone_enc!.toString("latin1")).not.toContain("09121234567");
    expect(rows[0].address_enc!.toString("utf8")).not.toContain("ولیعصر");
    expect(rows[0].notes_enc).not.toBeNull();
    expect(rows[0].phone_bidx).toMatch(/^[0-9a-f]{32}$/);

    const fetched = await dbLib.withTenant(biz.id, () => customers.getCustomer(biz.id, created.id));
    expect(fetched?.phone).toBe("09121234567");
    expect(fetched?.notes).toBe("همیشه بدون شکر");
  });

  it("finds a customer by their phone written any way, through the blind index", async () => {
    await dbLib.withTenant(biz.id, () =>
      customers.createCustomer(biz.id, { name: "علی رضایی", phone: "0912 765 4321" }),
    );
    for (const spelling of ["09127654321", "+989127654321", "0912 765 4321"]) {
      const found = await dbLib.withTenant(biz.id, () => customers.searchCustomers(biz.id, spelling));
      expect(found.map((c) => c.name)).toContain("علی رضایی");
    }
  });

  it("re-encrypts on update instead of leaving a stale ciphertext", async () => {
    const created = await dbLib.withTenant(biz.id, () =>
      customers.createCustomer(biz.id, { name: "به‌روزرسانی", phone: "09120000001" }),
    );
    const updated = await dbLib.withTenant(biz.id, () =>
      customers.updateCustomer(biz.id, created.id, { phone: "09120000002" }),
    );
    expect(updated?.phone).toBe("09120000002");
    const again = await dbLib.withTenant(biz.id, () => customers.getCustomer(biz.id, created.id));
    expect(again?.phone).toBe("09120000002");
  });
});

describe("the backfill", () => {
  it("encrypts rows written straight to SQL, and is a no-op the second time", async () => {
    const { rows } = await raw.query<{ id: string }>(
      `INSERT INTO customers (business_id, name, phone, address, notes)
       VALUES ($1, 'Legacy Row', '09125550000', 'somewhere', 'legacy note') RETURNING id`,
      [biz.id],
    );
    const id = rows[0].id;

    const first = await backfill.backfillBusiness(biz.id);
    expect(first.encrypted).toBeGreaterThan(0);

    const after = await raw.query<{ phone_enc: Buffer | null; phone_bidx: string | null }>(
      "SELECT phone_enc, phone_bidx FROM customers WHERE id = $1",
      [id],
    );
    expect(after.rows[0].phone_enc).not.toBeNull();
    expect(after.rows[0].phone_bidx).not.toBeNull();

    // Resumable means "does not redo what is done": a second pass finds nothing.
    const second = await backfill.backfillBusiness(biz.id);
    expect(second.encrypted).toBe(0);

    const read = await dbLib.withTenant(biz.id, () => customers.getCustomer(biz.id, id));
    expect(read?.phone).toBe("09125550000");
    expect(read?.notes).toBe("legacy note");
  });

  it("recovers a row whose plaintext was changed behind the services' back", async () => {
    // The 0125 trigger nulls the ciphertext when a writer that knows nothing
    // about encryption changes the plaintext. The row then reads correct (from
    // the plaintext twin) rather than stale, and the next backfill re-encrypts
    // it — the property that lets the older writers in crm-service and the
    // integrations sync keep working untouched.
    const { rows } = await raw.query<{ id: string }>(
      `INSERT INTO customers (business_id, name, phone) VALUES ($1, 'Trigger Row', '09125551111') RETURNING id`,
      [biz.id],
    );
    const id = rows[0].id;
    await backfill.backfillBusiness(biz.id);

    await raw.query("UPDATE customers SET phone = '09125552222' WHERE id = $1", [id]);
    const invalidated = await raw.query<{ phone_enc: Buffer | null; phone_bidx: string | null }>(
      "SELECT phone_enc, phone_bidx FROM customers WHERE id = $1",
      [id],
    );
    expect(invalidated.rows[0].phone_enc).toBeNull();
    expect(invalidated.rows[0].phone_bidx).toBeNull();

    const read = await dbLib.withTenant(biz.id, () => customers.getCustomer(biz.id, id));
    expect(read?.phone).toBe("09125552222");

    await backfill.backfillBusiness(biz.id);
    const reencrypted = await raw.query<{ phone_enc: Buffer | null }>(
      "SELECT phone_enc FROM customers WHERE id = $1",
      [id],
    );
    expect(reencrypted.rows[0].phone_enc).not.toBeNull();
  });

  it("leaves the database untouched on a dry run", async () => {
    const { rows } = await raw.query<{ id: string }>(
      `INSERT INTO customers (business_id, name, phone) VALUES ($1, 'Dry Run', '09125553333') RETURNING id`,
      [biz.id],
    );
    const result = await backfill.backfillBusiness(biz.id, { dryRun: true });
    expect(result.encrypted).toBeGreaterThan(0);
    const after = await raw.query<{ phone_enc: Buffer | null }>(
      "SELECT phone_enc FROM customers WHERE id = $1",
      [rows[0].id],
    );
    expect(after.rows[0].phone_enc).toBeNull();
    await backfill.backfillBusiness(biz.id);
  });
});

describe("tenant export", () => {
  it("decrypts on the way out and never emits ciphertext", async () => {
    const tenantExport = await import("../src/lib/tenant-export");
    const tables = await tenantExport.exportTenantData(biz.id);
    const exported = tables.find((t) => t.name === "customers")!;

    expect(exported.columns).not.toContain("phone_enc");
    expect(exported.columns).not.toContain("phone_bidx");
    const phones = exported.rows.map((r) => r.phone);
    expect(phones).toContain("09121234567");
    for (const row of exported.rows) {
      expect(Buffer.isBuffer(row.phone)).toBe(false);
    }
  });
});
