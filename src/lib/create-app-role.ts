import { Client } from "pg";

export const DEFAULT_APP_ROLE = "pos_app";

export interface AppRoleOptions {
  databaseUrl: string;
  roleName?: string;
  password: string;
  quiet?: boolean;
}

function assertSafeIdentifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`invalid_role_name: ${name}`);
  return name;
}

/** Idempotently provisions the restricted NOSUPERUSER/NOBYPASSRLS runtime role. */
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
    const quotedPassword = (
      await client.query<{ literal: string }>("SELECT quote_literal($1::text) AS literal", [options.password])
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
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`);
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
    );
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${role}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${role}`);
    await client.query(`REVOKE ALL ON TABLE schema_migrations FROM ${role}`);
    await client.query(`GRANT SELECT ON TABLE schema_migrations TO ${role}`);
    if (!options.quiet) console.log(`Role ${role} is ready on database ${database}.`);
    return { role };
  } finally {
    await client.end();
  }
}
