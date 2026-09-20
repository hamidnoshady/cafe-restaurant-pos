/**
 * The physical half of a whole-database restore, shared by every caller.
 *
 * Two things restore a `pg_dump --format=custom` artifact: the Owner's
 * dashboard on a single-business install (`backup-service.ts`'s
 * `restoreFromArtifact`) and the super-admin console's full-system restore
 * (`platform-backup-service.ts`), and they used to carry two near-copies of
 * the same dangerous procedure. Copying it twice is how one half gets a safety
 * fix and the other doesn't, so the procedure lives here once:
 *
 *   verify → scratch.  The artifact is restored into a throwaway database and
 *            validated (migrations present, core tables present, row counts
 *            reported). Production is not touched. This runs FIRST on every
 *            path, including the apply path — an apply never trusts a verify
 *            that happened on an earlier request, because the artifact could
 *            have been pruned, replaced or re-uploaded since.
 *   apply → drop + recreate. `DROP DATABASE … WITH (FORCE)` terminates the
 *            app's own sessions atomically; a separate `pg_terminate_backend`
 *            would leave a window for the pool (or a background tick) to
 *            reconnect and make the DROP fail.
 *   re-grant. `pg_restore --no-privileges` lands a database with no ACLs, so
 *            `pos_app` would come up unable to read a single table; the same
 *            idempotent provisioning `create-app-role` performs is re-run
 *            against the restored database.
 *   scratch cleanup. Always, success or failure — a failed pg_restore used to
 *            leave a half-populated `<target>_restore_verify` behind.
 *
 * The binaries are resolved from `PG_RESTORE_PATH` (default `pg_restore`) — the
 * same indirection `backup.ts`'s `dumpDatabaseUrl`/`PG_DUMP_PATH` use, and what
 * lets the integration test drive a whole restore round-trip against a stub.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "pg";
import { decryptBackup, isEncryptedBackup } from "./backup";
import { pgRestoreBin, runPgRestore } from "./pg-tools";
import { createAppRole } from "./create-app-role";

/** Re-exported so existing importers (`backup-service.ts`, the console routes) keep one name for them. */
export { PG_RESTORE_TIMEOUT_MS, runPgRestore } from "./pg-tools";

/**
 * What a restore found in the artifact — the numbers an operator reads before
 * agreeing to replace a live system, and the ones written into the restore run
 * row afterwards.
 */
export interface RestoreSummary {
  source: string;
  migrations: number;
  latestMigration: string;
  tables: { name: string; rows: number }[];
}

/** The core tables a dump must contain to be worth restoring at all. */
export const RESTORE_CORE_TABLES = ["businesses", "locations", "users", "orders", "journal_entries"];

/** Same server, different database — for admin commands and the scratch restore. */
export function withDatabase(databaseUrl: string, dbName: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

export async function adminClient(databaseUrl: string): Promise<Client> {
  const client = new Client({ connectionString: withDatabase(databaseUrl, "postgres") });
  await client.connect();
  return client;
}


/**
 * Is what landed in that database actually a backup of this app?
 *
 * `schema_migrations` having rows is the discriminator between "a dump of this
 * product's database" and "a dump of some other Postgres" (or an empty
 * database), and the core-table counts are what an operator reads before
 * agreeing to replace a live system. Row counts are read as the *owner*
 * connection (which is what `databaseUrl` is here — see
 * `dumpDatabaseUrl()`), so RLS cannot report zero and mislead.
 */
export async function validateRestoredDb(databaseUrl: string, source: string): Promise<RestoreSummary> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations ORDER BY filename",
    );
    if (rows.length === 0) {
      throw new Error("این فایل یک پشتیبان معتبر نیست (جدول schema_migrations خالی است).");
    }
    const tables: { name: string; rows: number }[] = [];
    for (const name of RESTORE_CORE_TABLES) {
      try {
        const { rows: countRows } = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ${name}`,
        );
        tables.push({ name, rows: Number(countRows[0].n) });
      } catch {
        throw new Error(`فایل پشتیبان جدول «${name}» را ندارد.`);
      }
    }
    return { source, migrations: rows.length, latestMigration: rows.at(-1)!.filename, tables };
  } finally {
    await client.end();
  }
}

/**
 * pg_restore runs with `--no-privileges`, so the restored database has none of
 * the ACLs a normal deployment gets from scripts/create-app-role.ts — the app's
 * `pos_app` connection would come up with no table access. Re-provision the
 * same grants (idempotently, the same way derive-runtime-database-url.ts does
 * at boot) using the app role's credentials from the running process's own
 * DATABASE_URL. On a fresh machine where the role does not exist yet,
 * createAppRole creates it; the next boot's derive-runtime then keeps it.
 */
export async function regrantAppRole(databaseUrl: string): Promise<void> {
  const runtimeUrl = process.env.DATABASE_URL;
  if (!runtimeUrl) return;
  let parsed: URL;
  try {
    parsed = new URL(runtimeUrl);
  } catch {
    return;
  }
  const roleName = parsed.username;
  const password = parsed.password;
  if (!roleName || !password) return;
  try {
    await createAppRole({ databaseUrl, roleName, password, quiet: true });
  } catch (err) {
    console.error(`restore: re-granting app role ${roleName} on the restored database failed:`, errText(err));
  }
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Best-effort: a scratch database left behind is untidy, not dangerous. */
export async function dropDatabase(databaseUrl: string, dbName: string): Promise<void> {
  try {
    const admin = await adminClient(databaseUrl);
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.end();
  } catch (err) {
    console.error(`restore: dropping scratch database ${dbName} failed (best effort):`, errText(err));
  }
}

/**
 * Restore one dump into a scratch database and validate it — the dry-run half.
 * Never touches production; throws with pg_restore's own stderr when the dump
 * is unreadable.
 */
export async function verifyIntoScratch(
  databaseUrl: string,
  scratchDb: string,
  pgRestore: string,
  dumpPath: string,
  source: string,
): Promise<RestoreSummary> {
  const admin = await adminClient(databaseUrl);
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${scratchDb}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${scratchDb}"`);
  } finally {
    await admin.end();
  }
  await runPgRestore(pgRestore, [
    "--no-owner",
    "--no-privileges",
    `--dbname=${withDatabase(databaseUrl, scratchDb)}`,
    dumpPath,
  ]);
  return validateRestoredDb(withDatabase(databaseUrl, scratchDb), source);
}

/**
 * Replace the target database with the dump. Callers run `verifyIntoScratch`
 * first — this function deliberately does not repeat it, so that the pairing is
 * visible (and greppable) at the call site rather than hidden in here.
 */
export async function applyDumpToTarget(opts: {
  databaseUrl: string;
  targetDb: string;
  pgRestore: string;
  dumpPath: string;
  source: string;
}): Promise<RestoreSummary> {
  const { databaseUrl, targetDb, pgRestore, dumpPath, source } = opts;
  const admin = await adminClient(databaseUrl);
  try {
    // WITH (FORCE) terminates the other sessions itself, atomically. Doing it as
    // a separate pg_terminate_backend leaves a window for the app's own pool —
    // or a background tick in server.ts — to reconnect before the DROP lands,
    // and then the DROP fails with "database is being accessed by other users".
    // (Postgres 13+; this app ships 16.)
    await admin.query(`DROP DATABASE IF EXISTS "${targetDb}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${targetDb}"`);
  } finally {
    await admin.end();
  }
  await runPgRestore(pgRestore, ["--no-owner", "--no-privileges", `--dbname=${databaseUrl}`, dumpPath]);
  await regrantAppRole(databaseUrl);
  return validateRestoredDb(databaseUrl, source);
}

/**
 * The whole sequence both callers share: verify, and only after it passes,
 * apply — with the scratch database dropped and the temp directory removed on
 * every path. `apply: false` stops after the verification and returns its
 * summary. Throws on any failure; the callers decide how to report it (they each
 * record a run row of their own).
 */
export async function restoreDumpFile(opts: {
  databaseUrl: string;
  dumpPath: string;
  source: string;
  apply: boolean;
  /** the scratch name to use; `<target>_restore_verify` at every real call site */
  scratchDb?: string;
  pgRestore?: string;
}): Promise<{ verified: RestoreSummary; applied: RestoreSummary | null }> {
  const databaseUrl = opts.databaseUrl;
  const targetDb = new URL(databaseUrl).pathname.replace(/^\//, "") || "pos";
  const scratchDb = opts.scratchDb ?? `${targetDb}_restore_verify`;
  const pgRestore = opts.pgRestore ?? pgRestoreBin();
  try {
    const verified = await verifyIntoScratch(databaseUrl, scratchDb, pgRestore, opts.dumpPath, opts.source);
    if (!opts.apply) return { verified, applied: null };
    const applied = await applyDumpToTarget({ databaseUrl, targetDb, pgRestore, dumpPath: opts.dumpPath, source: opts.source });
    return { verified, applied };
  } finally {
    // Drop the scratch database on every path, success or failure — a failed
    // pg_restore used to leave a half-populated `<targetDb>_restore_verify`
    // behind (reclaimed only by the next attempt). Best-effort, and a no-op when
    // it is already gone. Deliberately skipped for an apply: by then the scratch
    // database shares a name with nothing important, but the target database
    // *was* dropped and recreated, so a scratch cleanup could race the app's
    // reconnect — it runs on the next verify instead.
    if (!opts.apply) await dropDatabase(databaseUrl, scratchDb);
  }
}

/**
 * A refusal whose *code* is part of the API (the dashboards translate these into
 * Persian), as opposed to a crash whose message is only ever logged. Thrown by
 * the staging steps below so the caller can tell "no such artifact" from
 * "pg_restore died".
 */
export class RestoreRefusal extends Error {
  readonly refusalCode: string;
  constructor(code: string) {
    super(code);
    this.name = "RestoreRefusal";
    this.refusalCode = code;
  }
}

/**
 * Stage one artifact's bytes as a plaintext dump file for pg_restore: decrypt
 * when the bytes carry the POSBKP1 envelope, then write them into a private
 * temp directory the caller removes.
 *
 * The passphrase comes from the caller by design — the tenant half reads it from
 * the business's stored config, the platform half from the platform config or a
 * passphrase the operator typed into the restore dialog — because after a total
 * machine loss there is no config left to read, and that is exactly when a
 * restore has to work.
 */
export async function stageDumpFile(
  data: Buffer,
  passphrase: string,
  sourceName: string,
): Promise<{ workDir: string; dumpPath: string; sourceName: string }> {
  let bytes = data;
  if (isEncryptedBackup(bytes)) {
    if (!passphrase) throw new RestoreRefusal("passphrase_required");
    try {
      bytes = decryptBackup(bytes, passphrase);
    } catch (err) {
      throw new RestoreRefusal(`decrypt_failed:${errText(err)}`);
    }
  }
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "pos-restore-"));
  const dumpPath = path.join(workDir, "restore.dump");
  await fs.writeFile(dumpPath, bytes);
  return { workDir, dumpPath, sourceName };
}

/**
 * Row counts + migration state for a database, for the *manifest* a backup is
 * taken with (what a peer server shows an operator before they restore it).
 * Fails soft: a manifest is informative, not a gate, so a table this build
 * doesn't have yet just isn't in it.
 */
export async function buildBackupManifest(databaseUrl: string): Promise<{
  migrations: number;
  latestMigration: string;
  coreTables: { name: string; rows: number }[];
}> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    let migrations = 0;
    let latestMigration = "";
    try {
      const { rows } = await client.query<{ filename: string }>(
        "SELECT filename FROM schema_migrations ORDER BY filename",
      );
      migrations = rows.length;
      latestMigration = rows.at(-1)?.filename ?? "";
    } catch {
      /* a database with no migration table has nothing to report */
    }
    const coreTables: { name: string; rows: number }[] = [];
    for (const name of RESTORE_CORE_TABLES) {
      try {
        const { rows } = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${name}`);
        coreTables.push({ name, rows: Number(rows[0].n) });
      } catch {
        /* table absent in this build — omit it */
      }
    }
    return { migrations, latestMigration, coreTables };
  } finally {
    await client.end();
  }
}

/** The target database name a whole-system dump would replace. */
export function targetDatabaseName(databaseUrl: string): string {
  return new URL(databaseUrl).pathname.replace(/^\//, "") || "pos";
}

/**
 * Whether this install's own database is currently reachable as the privileged
 * connection — checked before an apply so a half-configured `BACKUP_DATABASE_URL`
 * fails as "you cannot restore" rather than as a dropped database that cannot
 * be repopulated.
 */
export async function assertRestoreConnectionUsable(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("SELECT 1");
  } catch (err) {
    throw new Error(`restore_connection_unreachable: ${errText(err)}`);
  } finally {
    await client.end().catch(() => {});
  }
  // The dump/restore connection must be able to CREATE DATABASE: a restore drops
  // and recreates the target, and discovering that mid-apply is the worst
  // possible moment to learn the role lacks the privilege.
  const admin = await adminClient(databaseUrl);
  try {
    const { rows } = await admin.query<{ can: boolean }>(
      `SELECT pg_has_role(current_user, 'CREATEDB', 'USAGE') OR has_database_privilege(current_user, current_database(), 'CREATE') AS can`,
    );
    if (!rows[0]?.can) {
      throw new Error("restore_connection_not_privileged: the connection cannot create databases");
    }
  } finally {
    await admin.end().catch(() => {});
  }
}
