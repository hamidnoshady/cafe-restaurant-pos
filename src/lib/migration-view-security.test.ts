import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static guard for the tenant-isolation hole migration 0144 opened.
 *
 * Migration 0021 set `security_invoker = on` on every `v_%` view, because a
 * view without it runs with its *owner's* rights and walks straight through
 * every row-level-security policy the same migration installed. The catch,
 * spelled out in 0065's own comment and confirmed against the server:
 *
 *     CREATE OR REPLACE VIEW resets pg_class.reloptions to NULL.
 *
 * So replacing a view silently drops `security_invoker` unless the migration
 * re-asserts it. 0061/0062/0063/0065/0076/0090/0119 all did. 0144 rewrote
 * `v_inventory_valuation` and did not — and that view then returned every
 * business's inventory to every caller until 0146 repaired it.
 *
 * `integration/tenant-isolation.integration.test.ts` already asserts the option
 * on the live schema, which is the authoritative check — but it needs a
 * database, so it only runs in the integration job. This test is plain `npm
 * test`: it reads the migration files and fails the moment a *new* migration
 * creates or replaces a view without re-asserting the option, naming the file
 * and the fix. The next 0144 fails here first, before it ever reaches a
 * database.
 */
const MIGRATIONS_DIR = resolve(fileURLToPath(new URL("./", import.meta.url)), "..", "..", "migrations");

/** `security_invoker` re-asserted for a specific view, e.g. ALTER VIEW v_x SET (security_invoker = on). */
const NAMED_ASSERTION = /ALTER\s+VIEW\s+(?:IF\s+EXISTS\s+)?"?([a-z0-9_]+)"?\s+SET\s*\(\s*security_invoker\s*=\s*on\s*\)/gi;

/**
 * The blanket loop 0021 and 0076 use: a `format('ALTER VIEW %I SET
 * (security_invoker = on)', v)` over a set of view names. It covers whatever
 * it iterates, so a file containing one is treated as covering every view it
 * touches rather than being parsed for names.
 */
const BLANKET_ASSERTION = /format\s*\(\s*'ALTER\s+VIEW\s+%I\s+SET\s*\(\s*security_invoker\s*=\s*on\s*\)'/i;

/** `CREATE [OR REPLACE] VIEW name` — matviews can't take security_invoker and are excluded. */
const VIEW_DEFINITION = /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z0-9_]+)"?/gi;

/** Strips `--` line comments and `/* *​/` blocks so prose about SQL is never read as SQL. */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

interface MigrationFile {
  filename: string;
  sql: string;
}

function loadMigrations(): MigrationFile[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((filename) => /^\d{4}_.+\.sql$/.test(filename))
    .sort()
    .map((filename) => ({
      filename,
      sql: stripComments(readFileSync(join(MIGRATIONS_DIR, filename), "utf8")),
    }));
}

/** True when a migration sweeps every `v_%` view, covering itself and everything before it. */
function hasBlanketSweep(migration: MigrationFile): boolean {
  return BLANKET_ASSERTION.test(migration.sql);
}

/** Views a migration defines that it never re-asserts `security_invoker` for. */
function unprotectedViews(migration: MigrationFile): string[] {
  if (hasBlanketSweep(migration)) return [];

  const defined = new Set<string>();
  for (const [, name] of migration.sql.matchAll(VIEW_DEFINITION)) {
    // Only tenant-facing reporting views are RLS-relevant; 0021's loop, the
    // integration assertion and this guard all key on the `v_` prefix.
    if (name.startsWith("v_")) defined.add(name);
  }
  if (defined.size === 0) return [];

  for (const [, name] of migration.sql.matchAll(NAMED_ASSERTION)) defined.delete(name);
  return [...defined].sort();
}

describe("migrations keep reporting views on security_invoker", () => {
  it("finds the migration files (guards against a broken path)", () => {
    const migrations = loadMigrations();
    expect(migrations.length).toBeGreaterThan(100);
    expect(migrations.some((m) => m.filename === "0021_row_level_security.sql")).toBe(true);
  });

  it("recognises both the named and the blanket form of the assertion", () => {
    // A regression test for the guard itself: if these stop matching, every
    // migration below would pass vacuously and the guard would protect nothing.
    expect(unprotectedViews({ filename: "x", sql: "CREATE VIEW v_a AS SELECT 1;" })).toEqual(["v_a"]);
    expect(
      unprotectedViews({
        filename: "x",
        sql: "CREATE VIEW v_a AS SELECT 1; ALTER VIEW v_a SET (security_invoker = on);",
      }),
    ).toEqual([]);
    expect(
      unprotectedViews({
        filename: "x",
        sql: "CREATE OR REPLACE VIEW v_a AS SELECT 1; EXECUTE format('ALTER VIEW %I SET (security_invoker = on)', v);",
      }),
    ).toEqual([]);
    // Commented-out SQL must not count as an assertion.
    expect(
      unprotectedViews({
        filename: "x",
        sql: stripComments("CREATE VIEW v_a AS SELECT 1;\n-- ALTER VIEW v_a SET (security_invoker = on);"),
      }),
    ).toEqual(["v_a"]);
  });

  it("re-asserts security_invoker in every migration that creates or replaces a view", () => {
    const migrations = loadMigrations();

    // A blanket sweep fixes up everything defined before it, so only migrations
    // that land *after* the most recent sweep still have to speak for
    // themselves. This is what makes the historical files legitimate: 0008-0017
    // predate 0021's sweep, and 0144 is an offender precisely because it is the
    // one post-sweep migration that replaced a view and stayed silent.
    const lastSweep = migrations.filter(hasBlanketSweep).at(-1);
    const coveredThrough = lastSweep ? lastSweep.filename : "";

    const offenders = migrations
      .filter((migration) => migration.filename > coveredThrough)
      .map((migration) => ({ migration, views: unprotectedViews(migration) }))
      .filter(({ views }) => views.length > 0)
      .map(({ migration, views }) => `${migration.filename}: ${views.join(", ")}`);

    expect(
      offenders.join("\n"),
      [
        `These migrations (after the last blanket sweep, ${coveredThrough}) define a`,
        "v_% view without re-asserting security_invoker:",
        offenders.join("\n"),
        "",
        "CREATE [OR REPLACE] VIEW resets pg_class.reloptions to NULL, so the view",
        "reverts to running with its OWNER's rights — bypassing every row-level",
        "security policy and leaking other businesses' rows (this is exactly the",
        "bug 0144 shipped and 0146 repaired).",
        "",
        "Add this after the view definition:",
        "    ALTER VIEW <view_name> SET (security_invoker = on);",
      ].join("\n"),
    ).toBe("");
  });
});
