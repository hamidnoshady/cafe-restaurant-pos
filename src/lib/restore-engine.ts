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
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "pg";
import { decryptBackup, isEncryptedBackup } from "./backup";
import { pgRestoreBin, runPgDump, runPgRestore } from "./pg-tools";
import { createAppRole } from "./create-app-role";
import { secureRemoveDirectory } from "./secure-temp";

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
  integrity: {
    encoding: "UTF8";
    validatedForeignKeys: number;
    checkedSequences: number;
  };
  /** Persistent pre-restore safety dump; present only after an apply. */
  emergencyBackup?: string;
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
    const encoding = await client.query<{ encoding: string }>(
      "SELECT pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname = current_database()",
    );
    if (encoding.rows[0]?.encoding !== "UTF8") throw new Error("restore_database_encoding_must_be_utf8");

    const tables: { name: string; rows: number }[] = [];
    for (const name of RESTORE_CORE_TABLES) {
      try {
        const { rows: countRows } = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ${name}`,
        );
        const count = BigInt(countRows[0].n);
        if (count > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`restore_row_count_too_large:${name}`);
        tables.push({ name, rows: Number(count) });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("restore_row_count_too_large:")) throw error;
        throw new Error(`فایل پشتیبان جدول «${name}» را ندارد.`);
      }
    }

    const fk = await client.query<{ total: string; invalid: string }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE NOT convalidated)::text AS invalid
         FROM pg_constraint WHERE contype = 'f'`,
    );
    if (fk.rows[0]?.invalid !== "0") throw new Error("restore_contains_unvalidated_foreign_keys");

    // A dump must restore sequence setval state as well as bigint IDs. Compare
    // using BigInt strings so values above JavaScript's safe integer range are
    // never rounded by validation.
    const sequences = await client.query<{
      sequence_schema: string;
      sequence_name: string;
      table_schema: string;
      table_name: string;
      column_name: string;
    }>(
      `SELECT sn.nspname AS sequence_schema, s.relname AS sequence_name,
              tn.nspname AS table_schema, t.relname AS table_name, a.attname AS column_name
         FROM pg_class s
         JOIN pg_namespace sn ON sn.oid = s.relnamespace
         JOIN pg_depend d ON d.objid = s.oid AND d.deptype IN ('a', 'i')
         JOIN pg_class t ON t.oid = d.refobjid
         JOIN pg_namespace tn ON tn.oid = t.relnamespace
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
        WHERE s.relkind = 'S'`,
    );
    for (const sequence of sequences.rows) {
      const sequenceSql = `${quoteIdentifier(sequence.sequence_schema)}.${quoteIdentifier(sequence.sequence_name)}`;
      const tableSql = `${quoteIdentifier(sequence.table_schema)}.${quoteIdentifier(sequence.table_name)}`;
      const state = await client.query<{ last_value: string; maximum: string | null }>(
        `SELECT (SELECT last_value::text FROM ${sequenceSql}) AS last_value,
                (SELECT max(${quoteIdentifier(sequence.column_name)})::text FROM ${tableSql}) AS maximum`,
      );
      const maximum = state.rows[0]?.maximum;
      if (maximum !== null && maximum !== undefined && BigInt(state.rows[0].last_value) < BigInt(maximum)) {
        throw new Error(`restore_sequence_behind_table:${sequence.table_schema}.${sequence.table_name}.${sequence.column_name}`);
      }
    }

    return {
      source,
      migrations: rows.length,
      latestMigration: rows.at(-1)!.filename,
      tables,
      integrity: {
        encoding: "UTF8",
        validatedForeignKeys: Number(fk.rows[0]?.total ?? 0),
        checkedSequences: sequences.rows.length,
      },
    };
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

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** Best-effort: a scratch database left behind is untidy, not dangerous. */
export async function dropDatabase(databaseUrl: string, dbName: string): Promise<void> {
  let admin: Client | null = null;
  try {
    admin = await adminClient(databaseUrl);
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(dbName)} WITH (FORCE)`);
  } catch (err) {
    console.error(`restore: dropping scratch database ${dbName} failed (best effort):`, errText(err));
  } finally {
    await admin?.end().catch(() => {});
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
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(scratchDb)} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(scratchDb)} ENCODING 'UTF8'`);
  } finally {
    await admin.end();
  }
  await runPgRestore(pgRestore, [
    "--exit-on-error",
    "--no-owner",
    "--no-privileges",
    `--dbname=${withDatabase(databaseUrl, scratchDb)}`,
    dumpPath,
  ], databaseUrl);
  return validateRestoredDb(withDatabase(databaseUrl, scratchDb), source);
}

/** Create, fsync and retain a verified safety dump of the live database. */
async function createEmergencyBackup(opts: {
  databaseUrl: string;
  targetDb: string;
  pgDump?: string;
  pgRestore: string;
  emergencyDir?: string;
}): Promise<string> {
  const directory = path.resolve(opts.emergencyDir || process.env.RESTORE_EMERGENCY_DIR || path.join(os.tmpdir(), "business-suite-emergency-backups"));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const finalPath = path.join(directory, `${opts.targetDb.replace(/[^A-Za-z0-9_-]/g, "_")}-emergency-${stamp}-${process.pid}-${randomUUID().slice(0, 8)}.dump`);
  const partialPath = `${finalPath}.partial`;
  try {
    await runPgDump(partialPath, opts.databaseUrl, opts.pgDump);
    await fs.chmod(partialPath, 0o600).catch(() => {});
    const handle = await fs.open(partialPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(partialPath, finalPath);

    // A backup existing is not enough; prove it can be restored before the live
    // database is renamed. This scratch is independent from the incoming dump.
    const emergencyScratch = databaseName(`${opts.targetDb}_emergency_verify_${process.pid}`);
    try {
      await verifyIntoScratch(opts.databaseUrl, emergencyScratch, opts.pgRestore, finalPath, path.basename(finalPath));
    } catch (error) {
      await fs.unlink(finalPath).catch(() => {});
      throw new Error(`emergency_backup_verification_failed:${errText(error)}`);
    } finally {
      await dropDatabase(opts.databaseUrl, emergencyScratch);
    }
    return finalPath;
  } finally {
    await fs.unlink(partialPath).catch(() => {});
  }
}

function databaseName(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_]/g, "_");
  return safe.slice(0, 63) || "pos_restore";
}

async function setDatabaseConnections(admin: Client, name: string, allowed: boolean): Promise<void> {
  await admin.query(`ALTER DATABASE ${quoteIdentifier(name)} WITH ALLOW_CONNECTIONS ${allowed ? "true" : "false"}`);
  if (!allowed) {
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [name],
    );
  }
}

async function rollbackDatabaseSwap(databaseUrl: string, targetDb: string, recoveryDb: string): Promise<void> {
  const admin = await adminClient(databaseUrl);
  try {
    const target = await admin.query<{ exists: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists", [targetDb]);
    if (target.rows[0]?.exists) {
      await setDatabaseConnections(admin, targetDb, false);
      await admin.query(`DROP DATABASE ${quoteIdentifier(targetDb)}`);
    }
    const recovery = await admin.query<{ exists: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists", [recoveryDb]);
    if (!recovery.rows[0]?.exists) throw new Error(`recovery_database_missing:${recoveryDb}`);
    await admin.query(`ALTER DATABASE ${quoteIdentifier(recoveryDb)} RENAME TO ${quoteIdentifier(targetDb)}`);
    await setDatabaseConnections(admin, targetDb, true);
  } finally {
    await admin.end().catch(() => {});
  }
}

/**
 * Apply an already-restored and validated scratch database by a controlled name
 * swap. The original database is retained under a recovery name until the new
 * target passes application validation and grants. Any failure rolls the name
 * swap back; the persistent, verified emergency dump is retained either way.
 */
export async function applyDumpToTarget(opts: {
  databaseUrl: string;
  targetDb: string;
  pgRestore: string;
  pgDump?: string;
  dumpPath: string;
  source: string;
  verifiedDb?: string;
  emergencyDir?: string;
  /** Integration-only deterministic crash points; never sourced from a request. */
  failureInjection?: "after_original_rename" | "after_target_swap" | "after_regrant";
}): Promise<RestoreSummary> {
  const { databaseUrl, targetDb, pgRestore, dumpPath, source } = opts;
  const preparedDb = opts.verifiedDb ?? databaseName(`${targetDb}_restore_prepared_${process.pid}`);
  let ownsPreparedDb = !opts.verifiedDb;
  if (ownsPreparedDb) await verifyIntoScratch(databaseUrl, preparedDb, pgRestore, dumpPath, source);
  else await validateRestoredDb(withDatabase(databaseUrl, preparedDb), source);

  const emergencyBackup = await createEmergencyBackup({
    databaseUrl,
    targetDb,
    pgDump: opts.pgDump,
    pgRestore,
    emergencyDir: opts.emergencyDir,
  });
  const recoveryDb = databaseName(`${targetDb}_restore_original_${Date.now().toString(36)}`);
  let originalRenamed = false;
  let preparedRenamed = false;
  try {
    const admin = await adminClient(databaseUrl);
    try {
      await setDatabaseConnections(admin, targetDb, false);
      await admin.query(`ALTER DATABASE ${quoteIdentifier(targetDb)} RENAME TO ${quoteIdentifier(recoveryDb)}`);
      originalRenamed = true;
      if (opts.failureInjection === "after_original_rename") throw new Error("injected_failure_after_original_rename");
      await admin.query(`ALTER DATABASE ${quoteIdentifier(preparedDb)} RENAME TO ${quoteIdentifier(targetDb)}`);
      preparedRenamed = true;
      if (opts.failureInjection === "after_target_swap") throw new Error("injected_failure_after_target_swap");
      ownsPreparedDb = false;
    } finally {
      await admin.end().catch(() => {});
    }

    await regrantAppRole(databaseUrl);
    if (opts.failureInjection === "after_regrant") throw new Error("injected_failure_after_regrant");
    const summary = await validateRestoredDb(databaseUrl, source);

    // The new target is now fully usable. Only now may the preserved original
    // be removed; the verified emergency dump remains for operator recovery.
    await dropDatabase(databaseUrl, recoveryDb);
    originalRenamed = false;
    return { ...summary, emergencyBackup };
  } catch (error) {
    if (originalRenamed) {
      try {
        await rollbackDatabaseSwap(databaseUrl, targetDb, recoveryDb);
        originalRenamed = false;
      } catch (rollbackError) {
        throw new Error(
          `restore_failed_and_rollback_requires_intervention:${errText(error)};rollback:${errText(rollbackError)};recovery_database:${recoveryDb};emergency_backup:${emergencyBackup}`,
        );
      }
    }
    throw new Error(`restore_apply_rolled_back:${errText(error)};emergency_backup:${emergencyBackup}`);
  } finally {
    if (ownsPreparedDb && !preparedRenamed) await dropDatabase(databaseUrl, preparedDb);
  }
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
  pgDump?: string;
  emergencyDir?: string;
  failureInjection?: "after_original_rename" | "after_target_swap" | "after_regrant";
}): Promise<{ verified: RestoreSummary; applied: RestoreSummary | null }> {
  const databaseUrl = opts.databaseUrl;
  const targetDb = new URL(databaseUrl).pathname.replace(/^\//, "") || "pos";
  const scratchDb = opts.scratchDb ?? `${targetDb}_restore_verify`;
  const pgRestore = opts.pgRestore ?? pgRestoreBin();
  try {
    const verified = await verifyIntoScratch(databaseUrl, scratchDb, pgRestore, opts.dumpPath, opts.source);
    if (!opts.apply) return { verified, applied: null };
    const applied = await applyDumpToTarget({
      databaseUrl,
      targetDb,
      pgRestore,
      pgDump: opts.pgDump,
      dumpPath: opts.dumpPath,
      source: opts.source,
      verifiedDb: scratchDb,
      emergencyDir: opts.emergencyDir,
      failureInjection: opts.failureInjection,
    });
    return { verified, applied };
  } finally {
    // After a successful apply the scratch database has been renamed to the
    // target, so this is a no-op. On every other path it removes partial data.
    await dropDatabase(databaseUrl, scratchDb);
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
  try {
    await fs.writeFile(dumpPath, bytes, { mode: 0o600 });
    return { workDir, dumpPath, sourceName };
  } catch (error) {
    await secureRemoveDirectory(workDir);
    throw error;
  }
}

/** Scrub the staged plaintext dump before removing its private directory. */
export async function cleanupStagedDump(workDir: string): Promise<void> {
  await secureRemoveDirectory(workDir);
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
