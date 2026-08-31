/**
 * Restore a per-tenant export (Phase 17 — src/lib/tenant-export.ts,
 * `GET /api/backup/export?format=sql`) into a database.
 *
 * Unlike scripts/restore.ts (a whole-database pg_dump artifact, restored via
 * DROP/CREATE DATABASE + pg_restore), a per-tenant export is plain SQL —
 * INSERT statements only, no schema — meant for "an already-migrated,
 * otherwise-empty database" (the export's own header comment, and the
 * literal Phase 17 exit criterion: "restores into a clean database without
 * carrying any other tenant's rows"). That makes the dry run much simpler
 * than Phase 10's scratch-database dance: since this is ordinary DML, the
 * default run wraps it in a transaction and ROLLBACKs instead of COMMITting
 * — no second database needed to verify safely.
 *
 * The default is a DRY RUN: the INSERTs run for real (so any constraint
 * violation — e.g. the target already has this business — surfaces exactly
 * as it would on a real restore) but are rolled back before returning. Only
 * `--apply --yes` commits.
 *
 * Usage:
 *   npx tsx scripts/restore-tenant.ts <export.sql>
 *   npx tsx scripts/restore-tenant.ts <export.sql> --apply --yes
 *
 * Options:
 *   --apply               after a successful dry run, commit for real (requires --yes)
 *   --yes                 confirm the --apply step
 *   --database-url <url>  target (default: DATABASE_URL from .env)
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { isEncryptedBackup, decryptBackup } from "../src/lib/backup";

const HEADER = [
  "-- Per-tenant data export (Phase 17). Restore into an already-migrated,",
  "-- otherwise-empty database — this carries data only, no schema.",
  "BEGIN;",
  "SET LOCAL session_replication_role = replica;",
].join("\n");
const FOOTER = "COMMIT;";

export class RestoreTenantError extends Error {}

/** Strips tenantDataToSql's own BEGIN;/COMMIT; wrapper, leaving just the INSERT statements — the caller supplies its own transaction control instead. */
export function extractStatements(sql: string): string {
  const trimmed = sql.trim();
  if (!trimmed.startsWith(HEADER) || !trimmed.endsWith(FOOTER)) {
    throw new RestoreTenantError(
      "this doesn't look like a per-tenant export from GET /api/backup/export?format=sql " +
        "(expected header/BEGIN;.../COMMIT; wrapper) — refusing to guess at an unrecognised file",
    );
  }
  return trimmed.slice(HEADER.length, trimmed.length - FOOTER.length);
}

export interface RestoreTenantResult {
  insertCount: number;
  committed: boolean;
}

/**
 * Runs a per-tenant export's INSERT statements against `client`, inside a
 * transaction. Rolls back (leaving the database untouched) unless `apply` is
 * true. Throws `RestoreTenantError` with a friendly hint if anything in the
 * export conflicts with data already in the target (most commonly: this
 * business already exists there).
 */
export async function restoreTenantExport(
  client: Client,
  sql: string,
  options: { apply: boolean },
): Promise<RestoreTenantResult> {
  const statements = extractStatements(sql);
  const insertCount = (statements.match(/^INSERT INTO/gm) ?? []).length;

  try {
    const { rows } = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM schema_migrations");
    if (Number(rows[0].n) === 0) {
      throw new RestoreTenantError("target database's schema_migrations is empty — migrate it first");
    }
  } catch (err) {
    if (err instanceof RestoreTenantError) throw err;
    throw new RestoreTenantError(`target doesn't look migrated (${(err as Error).message}) — migrate it first`);
  }

  await client.query("BEGIN");
  try {
    // Business-rule triggers (e.g. "an order's items can't change once it's
    // no longer open") exist to police live mutations, not to re-validate a
    // faithful replay of rows a real, already-consistent database produced —
    // every derived value here was already computed once, by the same
    // triggers, before export. `session_replication_role = replica` (the
    // standard mechanism logical replication itself uses for exactly this)
    // skips ordinary triggers for the rest of this transaction; SET LOCAL
    // keeps it scoped there, reverting automatically on COMMIT or ROLLBACK.
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(statements);
  } catch (err) {
    await client.query("ROLLBACK");
    throw new RestoreTenantError(
      `restore failed: ${(err as Error).message} — this usually means the target database already has ` +
        "this business (or one of its rows); restore only into a database that doesn't already contain it.",
    );
  }

  if (!options.apply) {
    await client.query("ROLLBACK");
    return { insertCount, committed: false };
  }

  await client.query("COMMIT");
  return { insertCount, committed: true };
}

interface Args {
  file: string | null;
  apply: boolean;
  yes: boolean;
  databaseUrl: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { file: null, apply: false, yes: false, databaseUrl: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--yes") args.yes = true;
    else if (a === "--database-url") args.databaseUrl = argv[++i] ?? null;
    else if (a.startsWith("--")) fail(`unknown option: ${a}`);
    else if (args.file) fail("only one file argument is allowed");
    else args.file = a;
  }
  return args;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = args.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) fail("DATABASE_URL is not set (or pass --database-url)");
  if (!args.file) fail("pass the exported .sql file's path");
  if (args.apply && !args.yes) fail("--apply commits the restore; add --yes to confirm (a dry run needs no flags)");

  let sqlData = readFileSync(args.file);
  if (isEncryptedBackup(sqlData)) {
    const passphrase = process.env.BACKUP_PASSPHRASE;
    if (!passphrase) fail("artifact is encrypted — set BACKUP_PASSPHRASE");
    console.log("Decrypting …");
    sqlData = decryptBackup(sqlData, passphrase) as any;
  }
  const sql = sqlData.toString("utf8");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await restoreTenantExport(client, sql, { apply: args.apply });
    console.log(`Export: ${args.file} (${result.insertCount} rows across its INSERT statements)`);
    if (!result.committed) {
      console.log("Dry run complete — every INSERT succeeded, then rolled back. The database was NOT changed.");
      console.log("Re-run with --apply --yes to commit for real.");
    } else {
      console.log("Restore complete — committed.");
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  } finally {
    await client.end();
  }
}

const entryPoint = process.argv[1] ? resolve(process.argv[1]) : null;
if (entryPoint === fileURLToPath(import.meta.url)) {
  void main();
}
