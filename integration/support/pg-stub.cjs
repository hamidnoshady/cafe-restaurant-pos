#!/usr/bin/env node
"use strict";
/**
 * The `pg_dump` / `pg_restore` stand-ins the platform-backup integration test
 * runs against (see integration/platform-system-backup.integration.test.ts).
 *
 * Why a stub exists at all: the pipeline's correctness is not about the two
 * binaries — it is about everything *around* them (artifact naming, the
 * encryption envelope, the checksum the peer verifies, the scratch database the
 * verify mode restores into, the run rows that end up in the console). A CI
 * image and a developer laptop with only `embedded-postgres` installed have no
 * client tools (that package ships just `initdb`, `pg_ctl`, `postgres`), so a
 * test that needs a real `pg_dump` cannot run anywhere. Pointing
 * `PG_DUMP_PATH`/`PG_RESTORE_PATH` at these two scripts drives the whole path
 * with a format this file both writes and reads.
 *
 * The "archive" is a text file of records the restore side can replay without a
 * parser cleverer than it needs to be:
 *
 *   POSSTUB1
 *   TABLE <name>
 *   DDL   <base64 of a CREATE TABLE built from pg_attribute>
 *   ROWS  <base64 of a JSON array of row objects>
 *
 * DDL is deliberately rebuilt from column types rather than copied from the real
 * dump: constraints, defaults, indexes and grants are exactly what `pg_restore`
 * would choke on in a scratch database, and none of it is what these tests
 * assert. `validateRestoredDb` counts rows and reads `schema_migrations`, and
 * that is the contract being satisfied.
 *
 * The table list is a fixed one rather than "everything", so the archive stays
 * small and deterministic; it is the same list the engine validates against.
 */
const CORE_TABLES = ["schema_migrations", "businesses", "locations", "users", "orders", "journal_entries"];

function argValue(argv, prefix) {
  const hit = argv.find((a) => a.startsWith(`${prefix}=`));
  if (hit) return hit.slice(prefix.length + 1);
  const i = argv.indexOf(prefix);
  return i >= 0 ? argv[i + 1] : "";
}

/** The last non-flag argument is the connection string in both tool shapes. */
function positionalUrl(argv) {
  for (let i = argv.length - 1; i >= 0; i -= 1) {
    const a = argv[i];
    if (a && !a.startsWith("-") && a.includes("://")) return a;
  }
  return "";
}

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s) => Buffer.from(s, "base64").toString("utf8");

async function dump(argv) {
  const out = argValue(argv, "--file");
  const url = positionalUrl(argv);
  if (!out || !url) {
    process.stderr.write("pg_dump-stub: need --file= and a connection url\n");
    process.exit(2);
  }
  const { Client } = require("pg");
  const c = new Client({ connectionString: url });
  await c.connect();
  const lines = ["POSSTUB1"];
  try {
    // Extensions and enums first: a scratch database has neither, and a column
    // of type `citext` or of an enum type cannot be created without them. Real
    // pg_dump emits these too — a "dump" that replays only the tables would
    // fail on any schema that uses one, which is exactly the bug a stub must not
    // hide.
    const ext = await c.query(
      "SELECT e.extname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE n.nspname = 'public' ORDER BY 1",
    );
    for (const row of ext.rows) lines.push(`EXT ${b64(`CREATE EXTENSION IF NOT EXISTS "${row.extname}"`)}`);
    const enums = await c.query(
      `SELECT 'CREATE TYPE "' || n.nspname || '"."' || t.typname || '" AS ENUM ('
         || string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder)
         || ')' AS ddl
         FROM pg_type t
         JOIN pg_namespace n ON n.oid = t.typnamespace
         JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE n.nspname = 'public'
        GROUP BY n.nspname, t.typname
        ORDER BY 1`,
    );
    for (const row of enums.rows) lines.push(`ENUM ${b64(row.ddl)}`);

    for (const table of CORE_TABLES) {
      const exists = await c.query(
        "SELECT to_regclass($1) AS r",
        [`public.${table}`],
      );
      if (!exists.rows[0].r) continue;
      const cols = await c.query(
        `SELECT a.attname::text AS name, format_type(a.atttypid, a.atttypmod) AS type
           FROM pg_attribute a
           JOIN pg_class cl ON cl.oid = a.attrelid
           JOIN pg_namespace ns ON ns.oid = cl.relnamespace
          WHERE ns.nspname = 'public' AND cl.relname = $1
            AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
          ORDER BY a.attnum`,
        [table],
      );
      if (cols.rows.length === 0) continue;
      const ddl = `CREATE TABLE "${table}" (${cols.rows.map((r) => `"${r.name}" ${r.type}`).join(", ")})`;
      // Rows go out as JSON so the restore side can bind them as parameters
      // instead of re-escaping SQL text it was never asked to parse.
      const rows = await c.query(`SELECT to_jsonb(t.*) AS j FROM "public"."${table}" t`);
      lines.push(`TABLE ${table}`, `DDL ${b64(ddl)}`, `ROWS ${b64(JSON.stringify(rows.rows.map((r) => r.j)))}`);
    }
  } finally {
    await c.end();
  }
  require("node:fs").writeFileSync(out, `${lines.join("\n")}\n`, "utf8");
}

async function restore(argv) {
  const url = argValue(argv, "--dbname") || positionalUrl(argv);
  const file = argv[argv.length - 1];
  if (!url || !file) {
    process.stderr.write("pg_restore-stub: need --dbname= and an input file\n");
    process.exit(2);
  }
  const text = require("node:fs").readFileSync(file, "utf8");
  const recs = text.split("\n");
  if (recs[0] !== "POSSTUB1") {
    process.stderr.write("pg_restore-stub: not a stub archive\n");
    process.exit(1);
  }
  const { Client } = require("pg");
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    // Prerequisites in file order, before any table: the header records are the
    // extensions and enum types the DDL below depends on.
    for (const rec of recs) {
      if (rec.startsWith("EXT ")) await c.query(unb64(rec.slice(4)));
      else if (rec.startsWith("ENUM ")) {
        // Idempotent by construction: a scratch database may already carry one
        // through a template, and a duplicate type must not abort the restore.
        await c.query(`DO $stub$ BEGIN ${unb64(rec.slice(5))}; EXCEPTION WHEN duplicate_object THEN NULL; END $stub$`);
      }
    }
    for (let i = 1; i < recs.length; i += 1) {
      if (!recs[i].startsWith("TABLE ")) continue;
      const table = recs[i].slice(6).trim();
      const ddl = unb64(recs[i + 1].slice(4));
      const rows = JSON.parse(unb64(recs[i + 2].slice(5)));
      await c.query(`DROP TABLE IF EXISTS "public"."${table}" CASCADE`);
      await c.query(ddl);
      for (const row of rows) {
        const keys = Object.keys(row || {});
        if (!keys.length) continue;
        const values = keys.map((k) => {
          const v = row[k];
          if (v === null || typeof v === "number" || typeof v === "boolean") return v;
          if (typeof v === "object") return JSON.stringify(v);
          return v;
        });
        const sql = `INSERT INTO "public"."${table}" (${keys.map((k) => `"${k}"`).join(", ")}) VALUES (${keys
          .map((_, idx) => `$${idx + 1}`)
          .join(", ")})`;
        await c.query(sql, values);
      }
    }
  } finally {
    await c.end();
  }
}

const mode = process.argv[2];
const rest = process.argv.slice(3);
const run =
  mode === "dump" ? dump(rest) : mode === "restore" ? restore(rest) : Promise.reject(new Error(`unknown mode ${mode}`));
run.catch((err) => {
  process.stderr.write(`${mode}-stub: ${err.message}\n`);
  process.exit(1);
});
