/** Phase 26 Holoo DB integration smoke tests. */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

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
  await runMigrations({ databaseUrl, quiet: true });
  client = new Client({ connectionString: databaseUrl });
  await client.connect();

  ({ rows: [{ id: businessId }] } = await client.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Holoo Biz', 'holoo-biz') RETURNING id",
  ));
  ({ rows: [{ id: locationId }] } = await client.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [businessId],
  ));
}, 120_000);

afterAll(async () => {
  await client?.end();
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
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

    const { rows } = await client.query<{ provider: string; schema_profile: string; direct_sql_profile_key: string }>(
      `SELECT c.provider, h.schema_profile, h.direct_sql_profile_key
         FROM integration_connections c JOIN holoo_connection_settings h ON h.connection_id = c.id
        WHERE c.id = $1`,
      [connectionId],
    );
    expect(rows[0]).toMatchObject({ provider: "holoo", schema_profile: "holoo-generic", direct_sql_profile_key: "holoo-generic" });
  });

  it("accepts Holoo document outbox kinds", async () => {
    const { rowCount } = await client.query(
      `INSERT INTO integration_outbox_events (business_id, connection_id, entity_type, remote_id, local_id, payload)
       VALUES ($1, $2, 'holoo_sale', 'order:1', NULL, '{"sourceId":"order:1","kind":"sale","values":[]}'::jsonb)`,
      [businessId, connectionId],
    );
    expect(rowCount).toBe(1);
  });
});
