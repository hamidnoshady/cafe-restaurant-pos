import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATION_ADVISORY_LOCK_ID, runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;

if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const databases: string[] = [];
const tempDirs: string[] = [];
const migrationsDirectory = join(process.cwd(), "migrations");

function maintenanceDatabaseUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

function databaseUrl(name: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${name}`;
  return url.toString();
}

async function createDatabase(): Promise<{ name: string; url: string }> {
  const name = `pos_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const client = new Client({ connectionString: maintenanceDatabaseUrl() });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }
  databases.push(name);
  return { name, url: databaseUrl(name) };
}

async function tempMigrations(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pos-migrations-"));
  tempDirs.push(dir);
  await Promise.all(Object.entries(files).map(([name, sql]) => writeFile(join(dir, name), sql, "utf8")));
  return dir;
}

afterEach(async () => {
  for (const name of databases.splice(0)) {
    const client = new Client({ connectionString: maintenanceDatabaseUrl() });
    await client.connect();
    try {
      await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await client.end();
    }
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("migration runner", () => {
  it("applies the repository migrations to a clean database and is a no-op on rerun", async () => {
    const database = await createDatabase();

    const first = await runMigrations({ databaseUrl: database.url });
    const second = await runMigrations({ databaseUrl: database.url });

    const expectedMigrations = readdirSync(migrationsDirectory)
      .filter((filename) => /^\d{4}_.+\.sql$/.test(filename))
      .sort()
      .map((filename) => ({
        filename,
        checksum: createHash("sha256").update(readFileSync(join(migrationsDirectory, filename))).digest("hex"),
      }));
    const client = new Client({ connectionString: database.url });
    await client.connect();
    const actualMigrations = await client.query<{ filename: string; checksum: string }>(
      "SELECT filename, checksum FROM schema_migrations ORDER BY filename",
    );
    await client.end();

    expect(first).toEqual({ applied: expectedMigrations.length, adoptedChecksums: 0 });
    expect(actualMigrations.rows).toEqual(expectedMigrations);
    expect(second).toEqual({ applied: 0, adoptedChecksums: 0 });
  }, 60_000);

  it("serializes concurrent runners with the advisory lock", async () => {
    const database = await createDatabase();
    const migrationsDir = await tempMigrations({
      "0001_guard.sql": "CREATE TABLE concurrency_guard(id integer PRIMARY KEY);",
    });
    const blocker = new Client({ connectionString: database.url });
    await blocker.connect();
    await blocker.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_ADVISORY_LOCK_ID]);

    const runners = [
      runMigrations({ databaseUrl: database.url, migrationsDir, quiet: true }),
      runMigrations({ databaseUrl: database.url, migrationsDir, quiet: true }),
    ];

    const deadline = Date.now() + 5_000;
    let waitingRunners = 0;
    while (Date.now() < deadline) {
      const result = await blocker.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND wait_event = 'advisory'
      `);
      waitingRunners = Number(result.rows[0]?.count ?? 0);
      if (waitingRunners === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(waitingRunners).toBe(2);
    await blocker.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_ADVISORY_LOCK_ID]);
    await blocker.end();

    const [first, second] = await Promise.all(runners);

    expect([first.applied, second.applied].sort()).toEqual([0, 1]);
  });

  it("upgrades an existing 0011 database through every later migration", async () => {
    const database = await createDatabase();
    const dir = await mkdtemp(join(tmpdir(), "pos-upgrade-"));
    tempDirs.push(dir);
    const files = readdirSync(migrationsDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
    for (const file of files.filter((name) => name <= "0011_delivery.sql")) {
      await copyFile(join(migrationsDirectory, file), join(dir, file));
    }
    await runMigrations({ databaseUrl: database.url, migrationsDir: dir, quiet: true });
    for (const file of files.filter((name) => name > "0011_delivery.sql")) {
      await copyFile(join(migrationsDirectory, file), join(dir, file));
    }
    const upgraded = await runMigrations({ databaseUrl: database.url, migrationsDir: dir, quiet: true });
    const rerun = await runMigrations({ databaseUrl: database.url, migrationsDir: dir, quiet: true });
    expect(upgraded.applied).toBe(files.length - 11);
    expect(rerun).toEqual({ applied: 0, adoptedChecksums: 0 });
  }, 60_000);

  it("adopts a checksum for legacy migration rows once", async () => {
    const database = await createDatabase();
    const migrationsDir = await tempMigrations({ "0001_legacy.sql": "SELECT 1;" });
    const client = new Client({ connectionString: database.url });
    await client.connect();
    try {
      await client.query(
        "CREATE TABLE schema_migrations(filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      await client.query("INSERT INTO schema_migrations(filename) VALUES('0001_legacy.sql')");
    } finally {
      await client.end();
    }

    await expect(runMigrations({ databaseUrl: database.url, migrationsDir, quiet: true })).resolves.toEqual({
      applied: 0,
      adoptedChecksums: 1,
    });
    await expect(runMigrations({ databaseUrl: database.url, migrationsDir, quiet: true })).resolves.toEqual({
      applied: 0,
      adoptedChecksums: 0,
    });
  });

  it("rejects drift in an already-applied migration", async () => {
    const database = await createDatabase();
    const migrationsDir = await tempMigrations({ "0001_value.sql": "CREATE TABLE value_one(id integer);" });
    await runMigrations({ databaseUrl: database.url, migrationsDir, quiet: true });
    await writeFile(join(migrationsDir, "0001_value.sql"), "CREATE TABLE value_two(id integer);", "utf8");

    await expect(runMigrations({ databaseUrl: database.url, migrationsDir, quiet: true })).rejects.toThrow(
      "migration_checksum_mismatch: 0001_value.sql",
    );
  });
});
