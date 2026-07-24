/**
 * Minimal forward-only SQL migration runner.
 *
 * Applies migrations/NNNN_name.sql files in filename order, each inside a
 * transaction, and records applied files in schema_migrations.
 *
 * Usage: npm run db:migrate
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
export const MIGRATION_ADVISORY_LOCK_ID = "7310318183545164275";

export interface MigrationRunOptions {
  databaseUrl: string;
  migrationsDir?: string;
  quiet?: boolean;
}

export interface MigrationRunResult {
  applied: number;
  adoptedChecksums: number;
}

interface MigrationFile {
  filename: string;
  checksum: string;
  sql: string;
}

function loadMigrations(directory: string): MigrationFile[] {
  return readdirSync(directory)
    .filter((filename) => /^\d{4}_.+\.sql$/.test(filename))
    .sort()
    .map((filename) => {
      const contents = readFileSync(join(directory, filename));
      return {
        filename,
        checksum: createHash("sha256").update(contents).digest("hex"),
        sql: contents.toString("utf8"),
      };
    });
}

export async function runMigrations(options: MigrationRunOptions): Promise<MigrationRunResult> {
  const client = new Client({ connectionString: options.databaseUrl });
  let lockAcquired = false;
  let adoptedChecksums = 0;
  let appliedCount = 0;

  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_ADVISORY_LOCK_ID]);
    lockAcquired = true;

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        checksum   text,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text");

    const migrations = loadMigrations(options.migrationsDir ?? MIGRATIONS_DIR);
    const { rows } = await client.query<{ filename: string; checksum: string | null }>(
      "SELECT filename, checksum FROM schema_migrations",
    );
    const applied = new Map(rows.map((row) => [row.filename, row.checksum]));

    for (const migration of migrations) {
      if (!applied.has(migration.filename)) continue;
      const storedChecksum = applied.get(migration.filename);
      if (storedChecksum === null) {
        await client.query(
          "UPDATE schema_migrations SET checksum = $2 WHERE filename = $1 AND checksum IS NULL",
          [migration.filename, migration.checksum],
        );
        applied.set(migration.filename, migration.checksum);
        adoptedChecksums++;
        continue;
      }
      if (storedChecksum !== migration.checksum) {
        throw new Error(`migration_checksum_mismatch: ${migration.filename}`);
      }
    }

    for (const migration of migrations) {
      if (applied.has(migration.filename)) continue;
      if (!options.quiet) process.stdout.write(`Applying ${migration.filename} ... `);
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
          [migration.filename, migration.checksum],
        );
        await client.query("COMMIT");
        if (!options.quiet) console.log("ok");
        appliedCount++;
      } catch (error) {
        await client.query("ROLLBACK");
        if (!options.quiet) console.log("FAILED");
        throw error;
      }
    }

    return { applied: appliedCount, adoptedChecksums };
  } finally {
    try {
      if (lockAcquired) {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_ADVISORY_LOCK_ID]);
      }
    } finally {
      await client.end();
    }
  }
}

export async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env first.");
    process.exitCode = 1;
    return;
  }

  const result = await runMigrations({ databaseUrl });
  if (result.adoptedChecksums > 0) {
    console.log(`Adopted checksum(s) for ${result.adoptedChecksums} existing migration(s).`);
  }
  console.log(result.applied === 0 ? "Nothing to do — schema is up to date." : `Applied ${result.applied} migration(s).`);
}

const entryPoint = process.argv[1] ? resolve(process.argv[1]) : null;
if (entryPoint === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
