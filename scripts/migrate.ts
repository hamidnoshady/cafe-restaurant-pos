/**
 * Minimal forward-only SQL migration runner.
 *
 * Applies migrations/NNNN_name.sql files in filename order, each inside a
 * transaction, and records applied files in schema_migrations.
 *
 * Usage: npm run db:migrate
 */
import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env first.");
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = new Set(
      (await client.query("SELECT filename FROM schema_migrations")).rows.map(
        (r: { filename: string }) => r.filename,
      ),
    );

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f))
      .sort();

    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      process.stdout.write(`Applying ${file} ... `);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [file],
        );
        await client.query("COMMIT");
        console.log("ok");
        ran++;
      } catch (err) {
        await client.query("ROLLBACK");
        console.log("FAILED");
        throw err;
      }
    }

    console.log(
      ran === 0 ? "Nothing to do — schema is up to date." : `Applied ${ran} migration(s).`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
