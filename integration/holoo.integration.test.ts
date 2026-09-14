/** Phase 26 Holoo DB integration smoke tests. */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { WELL_KNOWN_CODES } from "../src/lib/coa-template";
import { closeDatabasePool, withTenant } from "../src/lib/db";
import { importOpeningBalance } from "../src/lib/integrations/holoo/journal-import-service";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl)
  throw new Error("DATABASE_URL is required for database integration tests");

let databaseName: string;
let client: Client;
let businessId: string;
let locationId: string;
let connectionId: string;

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
  databaseName = `pos_holoo_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  const databaseUrl = urlFor(databaseName);
  process.env.DATABASE_URL = databaseUrl;
  await closeDatabasePool();
  await runMigrations({ databaseUrl, quiet: true });
  client = new Client({ connectionString: databaseUrl });
  await client.connect();

  ({
    rows: [{ id: businessId }],
  } = await client.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Holoo Biz', 'holoo-biz') RETURNING id",
  ));
  ({
    rows: [{ id: locationId }],
  } = await client.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [businessId],
  ));
}, 120_000);

afterAll(async () => {
  await closeDatabasePool();
  await client?.end();
  process.env.DATABASE_URL = rootDatabaseUrl;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(
      `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
    );
  } finally {
    await maintenance.end();
  }
});

describe("Holoo integration schema", () => {
  it("allows a Holoo connection without WooCommerce credentials while preserving WooCommerce credential checks", async () => {
    await expect(
      client.query(
        `INSERT INTO integration_connections (business_id, location_id, name, provider, base_url, currency_unit)
         VALUES ($1, $2, 'Bad Woo', 'woocommerce', NULL, 'toman')`,
        [businessId, locationId],
      ),
    ).rejects.toThrow();

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO integration_connections (business_id, location_id, name, provider, base_url, currency_unit)
       VALUES ($1, $2, 'Holoo', 'holoo', NULL, 'rial') RETURNING id`,
      [businessId, locationId],
    );
    connectionId = inserted.rows[0].id;

    await client.query(
      `INSERT INTO holoo_connection_settings
         (business_id, connection_id, host, port, database, currency_unit, write_mode, schema_profile, direct_sql_profile_key)
       VALUES ($1, $2, '192.168.1.10', 1433, 'HolooDb', 'rial', 'direct_sql', 'holoo-generic', 'holoo-generic')`,
      [businessId, connectionId],
    );

    const { rows } = await client.query<{
      provider: string;
      schema_profile: string;
      direct_sql_profile_key: string;
    }>(
      `SELECT c.provider, h.schema_profile, h.direct_sql_profile_key
         FROM integration_connections c JOIN holoo_connection_settings h ON h.connection_id = c.id
        WHERE c.id = $1`,
      [connectionId],
    );
    expect(rows[0]).toMatchObject({
      provider: "holoo",
      schema_profile: "holoo-generic",
      direct_sql_profile_key: "holoo-generic",
    });
  });

  it("accepts Holoo document outbox kinds", async () => {
    const { rowCount } = await client.query(
      `INSERT INTO integration_outbox_events (business_id, connection_id, entity_type, remote_id, local_id, payload)
       VALUES ($1, $2, 'holoo_sale', 'order:1', NULL, '{"sourceId":"order:1","kind":"sale","values":[]}'::jsonb)`,
      [businessId, connectionId],
    );
    expect(rowCount).toBe(1);
  });

  it("imports opening balances through the exact journal path without losing large Rial precision", async () => {
    const assetCode = "1999";
    const exactRial = 9007199254740993n;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO integration_connections (business_id, location_id, name, provider, base_url, currency_unit)
       VALUES ($1, $2, 'Holoo Opening', 'holoo', NULL, 'rial') RETURNING id`,
      [businessId, locationId],
    );

    await client.query(
      `INSERT INTO accounts (business_id, code, name, type)
       VALUES ($1, $2, 'Imported asset', 'asset'),
              ($1, $3, 'Opening equity', 'equity')`,
      [businessId, assetCode, WELL_KNOWN_CODES.openingEquity],
    );

    const result = await withTenant(businessId, () =>
      importOpeningBalance(
        businessId,
        inserted.rows[0].id,
        [{ accountCode: assetCode, debitRial: exactRial }],
        null,
      ),
    );

    expect(result.entryId).toBeTruthy();
    expect(result.unmappedAccounts).toEqual([]);

    const { rows } = await client.query<{
      code: string;
      debit: string;
      credit: string;
    }>(
      `SELECT a.code, jl.debit::text AS debit, jl.credit::text AS credit
         FROM journal_lines jl
         JOIN accounts a ON a.id = jl.account_id
        WHERE jl.entry_id = $1
        ORDER BY a.code`,
      [result.entryId],
    );
    const byCode = new Map(
      rows.map((row) => [row.code, { debit: row.debit, credit: row.credit }]),
    );
    expect(byCode.get(assetCode)).toEqual({
      debit: exactRial.toString(),
      credit: "0",
    });
    expect(byCode.get(WELL_KNOWN_CODES.openingEquity)).toEqual({
      debit: "0",
      credit: exactRial.toString(),
    });
  });
});
