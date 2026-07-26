/**
 * Provisions the unprivileged database role the application should connect as.
 *
 * Phase 12 enforces tenant isolation with Postgres Row-Level Security, and RLS
 * is ignored outright by superusers and by roles holding BYPASSRLS. The stock
 * `docker-compose.yml` creates `pos` as the database superuser, so connecting
 * the app as `pos` would leave every policy in migration 0021 doing nothing —
 * silently, with no error to notice.
 *
 * This script creates (or updates) a NOSUPERUSER / NOBYPASSRLS role, grants it
 * exactly the table access the app needs, and sets default privileges so the
 * next migration's tables are covered too. Run it once per database, after
 * migrating:
 *
 *   DATABASE_URL=postgres://pos:pos@localhost:5432/pos \
 *   APP_DB_PASSWORD=<secret> npm run db:app-role
 *
 * Then point the application's DATABASE_URL at the new role. Migrations keep
 * running as the owner — they create tables, and the app role must not.
 *
 * Idempotent: safe to re-run after every deploy, and re-running rotates the
 * password to whatever APP_DB_PASSWORD currently is.
 */
import "dotenv/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

export const DEFAULT_APP_ROLE = "pos_app";

export interface AppRoleOptions {
  databaseUrl: string;
  roleName?: string;
  password: string;
  quiet?: boolean;
}

/** Postgres identifiers can't be parameterised, so validate rather than interpolate blindly. */
function assertSafeIdentifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(`invalid_role_name: ${name}`);
  }
  return name;
}

export async function createAppRole(options: AppRoleOptions): Promise<{ role: string }> {
  const role = assertSafeIdentifier(options.roleName ?? DEFAULT_APP_ROLE);
  if (!options.password) throw new Error("APP_DB_PASSWORD is required");

  const client = new Client({ connectionString: options.databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
      [role],
    );

    // CREATE/ALTER ROLE are utility statements and cannot take bind
    // parameters, so let the server produce a correctly escaped literal
    // instead of hand-rolling quoting around a secret.
    const quotedPassword = (
      await client.query<{ literal: string }>("SELECT quote_literal($1::text) AS literal", [
        options.password,
      ])
    ).rows[0].literal;

    const attributes = "LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE";
    await client.query(
      rows[0].exists
        ? `ALTER ROLE ${role} WITH ${attributes} PASSWORD ${quotedPassword}`
        : `CREATE ROLE ${role} WITH ${attributes} PASSWORD ${quotedPassword}`,
    );

    const database = (await client.query<{ current_database: string }>("SELECT current_database()"))
      .rows[0].current_database;

    await client.query(`GRANT CONNECT ON DATABASE "${database}" TO ${role}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);

    // Data access only. No CREATE on the schema, no ownership: the app must not
    // be able to add a table (which would arrive without an RLS policy), drop a
    // policy, or ALTER ... NO FORCE ROW LEVEL SECURITY its way out of isolation.
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
    );
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`);

    // Whatever the next migration creates, the app role can use without a
    // second trip through this script.
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public
         GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${role}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${role}`,
    );

    // schema_migrations is the runner's bookkeeping, not application data.
    await client.query(`REVOKE ALL ON TABLE schema_migrations FROM ${role}`);
    await client.query(`GRANT SELECT ON TABLE schema_migrations TO ${role}`);

    if (!options.quiet) {
      console.log(`Role ${role} is ready on database ${database}.`);
      console.log(`Point the app at: postgres://${role}:<password>@<host>:<port>/${database}`);
    }
    return { role };
  } finally {
    await client.end();
  }
}

export async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env first.");
    process.exitCode = 1;
    return;
  }
  const password = process.env.APP_DB_PASSWORD;
  if (!password) {
    console.error("APP_DB_PASSWORD is not set. Generate one with: openssl rand -hex 32");
    process.exitCode = 1;
    return;
  }

  await createAppRole({
    databaseUrl,
    roleName: process.env.APP_DB_USER || DEFAULT_APP_ROLE,
    password,
  });
}

const entryPoint = process.argv[1] ? resolve(process.argv[1]) : null;
if (entryPoint === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
