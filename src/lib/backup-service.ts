/**
 * Phase 10 — backup system: the half that touches the database, the
 * filesystem, pg_dump, and the network (like the other *-service.ts files,
 * not unit-tested directly — the decision logic it leans on lives in
 * src/lib/backup.ts and is).
 *
 * Pipeline per run:
 *   1. `pg_dump --format=custom` of the WHOLE local database into
 *      BACKUP_DIR (atomic: dump to *.tmp, fsync, rename). It connects with
 *      `dumpDatabaseUrl()`, not the app's own restricted connection — RLS
 *      makes pg_dump fail outright as `pos_app`.
 *   2. Copy the artifact to BACKUP_SECONDARY_DIR if configured (USB/NAS) —
 *      a failed copy fails the run, because a silently-unplugged drive is
 *      exactly what the Owner wants alerted about.
 *   3. Encrypt (AES-256-GCM, Owner's passphrase) and upload to
 *      S3-compatible storage when cloud backup is enabled. A failed upload
 *      is retried on later ticks until a newer artifact supersedes it, so a
 *      backup taken offline still reaches the cloud when internet returns.
 *   4. Prune local artifacts and cloud objects beyond their retention
 *      counts (never touching files that aren't backup artifacts).
 *
 * Every step is recorded in `backup_runs`; the dashboard's health card and
 * the Owner-dashboard alert read from there.
 */
import { spawn } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "pg";
import { query, withTenant, withoutTenantScope } from "./db";
import { getSetting, setSetting, SETTING_KEYS } from "./settings";
import {
  BACKUP_RUNS_SHOWN,
  CLOUD_RETRY_MS,
  cloudKeyFor,
  computeBackupAlert,
  DEFAULT_BACKUP_CONFIG,
  decryptBackup,
  dumpDatabaseUrl,
  encryptBackup,
  isBackupDue,
  isEncryptedBackup,
  isPlainArtifactName,
  makeArtifactName,
  selectPrunable,
  type BackupAlert,
  type BackupConfig,
} from "./backup";
import { s3Delete, s3Get, s3List, s3Put, sha256Hex, type S3Config } from "./s3-lite";
// Phase 35 — queued, never sent inline, and error-swallowing: a backup run's
// outcome must not depend on whether anybody could be told about it.
import { recordNotification } from "./notification-events";
import { notificationDedupeKey } from "./notifications";

const PG_DUMP_TIMEOUT_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Config + paths
// ---------------------------------------------------------------------------

/**
 * Where local artifacts go. The Owner-chosen `config.directory` wins when set
 * (the standalone desktop app writes it from an OS folder dialog — often an
 * external drive); otherwise this is exactly what it always was, so no
 * existing deployment moves its backups.
 */
export function backupDir(configuredDirectory?: string): string {
  return (
    configuredDirectory?.trim() || process.env.BACKUP_DIR || path.join(process.cwd(), "backups")
  );
}

export function backupSecondaryDir(): string | null {
  return process.env.BACKUP_SECONDARY_DIR || null;
}

export async function getBackupConfig(businessId: string): Promise<BackupConfig> {
  const stored = await getSetting<BackupConfig>(businessId, SETTING_KEYS.backupConfig);
  if (!stored) return structuredClone(DEFAULT_BACKUP_CONFIG);
  return { ...DEFAULT_BACKUP_CONFIG, ...stored, cloud: { ...DEFAULT_BACKUP_CONFIG.cloud, ...stored.cloud } };
}

export async function setBackupConfig(businessId: string, config: BackupConfig): Promise<void> {
  await setSetting(businessId, SETTING_KEYS.backupConfig, config);
}

/** Config for the Owner UI: secrets are never echoed back, only "is set" flags. */
export async function getBackupConfigMasked(businessId: string) {
  const config = await getBackupConfig(businessId);
  return {
    ...config,
    cloud: {
      ...config.cloud,
      secretAccessKey: "",
      passphrase: "",
      hasSecretAccessKey: Boolean(config.cloud.secretAccessKey),
      hasPassphrase: Boolean(config.cloud.passphrase),
    },
  };
}

function s3ConfigOf(config: BackupConfig): S3Config {
  const { endpoint, region, bucket, accessKeyId, secretAccessKey } = config.cloud;
  return { endpoint, region, bucket, accessKeyId, secretAccessKey };
}

/** The business's local timezone (its primary location's; Tehran fallback). */
async function getBusinessTimezone(businessId: string): Promise<string> {
  const { rows } = await query<{ timezone: string | null }>(
    `SELECT timezone FROM locations
      WHERE business_id = $1 AND is_active ORDER BY created_at LIMIT 1`,
    [businessId],
  );
  return rows[0]?.timezone || "Asia/Tehran";
}

// ---------------------------------------------------------------------------
// Run bookkeeping
// ---------------------------------------------------------------------------

type RunKind = "local" | "cloud";
type RunTrigger = "scheduled" | "manual";

async function startRun(
  businessId: string,
  kind: RunKind,
  trigger: RunTrigger,
  artifact: string | null,
  cloudKey: string | null,
): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO backup_runs (business_id, kind, trigger, artifact, cloud_key)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [businessId, kind, trigger, artifact, cloudKey],
  );
  return rows[0].id;
}

async function finishRun(
  runId: string,
  outcome:
    | { status: "success"; artifact?: string; sizeBytes: number; sha256: string }
    | { status: "failed"; error: string },
): Promise<void> {
  if (outcome.status === "success") {
    await query(
      `UPDATE backup_runs
          SET status = 'success', artifact = coalesce($2, artifact),
              size_bytes = $3, sha256 = $4, finished_at = now()
        WHERE id = $1`,
      [runId, outcome.artifact ?? null, outcome.sizeBytes, outcome.sha256],
    );
  } else {
    const { rows } = await query<{ business_id: string; kind: string }>(
      `UPDATE backup_runs SET status = 'failed', error = $2, finished_at = now()
        WHERE id = $1 RETURNING business_id, kind`,
      [runId, outcome.error.slice(0, 1000)],
    );

    // Phase 35 — the one notification whose entire value is arriving at the
    // wrong hour. A backup that has silently failed for a week is discovered
    // exactly when it is too late to matter, which is why this is the
    // catalogue's only `critical` event and why it ignores quiet hours.
    const failed = rows[0];
    if (failed) {
      await recordNotification({
        businessId: failed.business_id,
        locationId: null,
        eventKey: "backup.failed",
        severity: "critical",
        title: "پشتیبان‌گیری ناموفق بود",
        body: outcome.error.slice(0, 200),
        url: "/dashboard/backup",
        // Keyed on the run, so one failed run is one notification however many
        // times the tick re-reads it.
        dedupeKey: notificationDedupeKey("backup.failed", runId),
        payload: { runId, kind: failed.kind },
      });
    }
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Local backup (pg_dump)
// ---------------------------------------------------------------------------

/** One in-flight backup per business per process (the tick is 60s; dumps can be slower). */
const inFlight = new Set<string>();

function runPgDump(outFile: string): Promise<void> {
  let databaseUrl: string;
  try {
    databaseUrl = dumpDatabaseUrl();
  } catch (err) {
    return Promise.reject(err);
  }
  const bin = process.env.PG_DUMP_PATH || "pg_dump";
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["--format=custom", "--no-password", `--file=${outFile}`, databaseUrl], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: PG_DUMP_TIMEOUT_MS,
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString();
    });
    child.on("error", (err) =>
      reject(new Error(`could not start ${bin}: ${err.message} (set PG_DUMP_PATH or install postgresql-client)`)),
    );
    child.on("close", (code, signal) => {
      if (code === 0) return resolve();
      // The RLS failure is the one pg_dump error an operator can't decode from
      // its own message — see dumpDatabaseUrl() for why it happens.
      const hint = /row-level security/.test(stderr)
        ? " — pg_dump must connect as the privileged (migration/owner) role; point BACKUP_DATABASE_URL at it"
        : "";
      reject(new Error(`pg_dump exited with ${signal ?? code}: ${stderr.trim().slice(0, 500)}${hint}`));
    });
  });
}

async function pruneDirectory(dir: string, keep: number): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of selectPrunable(names, keep)) {
    await fs.unlink(path.join(dir, name)).catch((err) => {
      console.error(`backup: failed to prune ${path.join(dir, name)}:`, errText(err));
    });
  }
}

export type LocalBackupResult =
  | { status: "ok"; runId: string; artifact: string; sizeBytes: number }
  | { status: "busy" }
  | { status: "failed"; error: string };

/**
 * Take one local backup now (scheduled tick and the dashboard's "backup now"
 * share this code path). Never throws — failures land in backup_runs.
 */
export async function runLocalBackup(businessId: string, trigger: RunTrigger): Promise<LocalBackupResult> {
  if (inFlight.has(businessId)) return { status: "busy" };
  inFlight.add(businessId);
  try {
    const config = await getBackupConfig(businessId);
    const artifact = makeArtifactName();
    const runId = await startRun(businessId, "local", trigger, artifact, null);
    try {
      const dir = backupDir(config.directory);
      await fs.mkdir(dir, { recursive: true });
      const finalPath = path.join(dir, artifact);
      const tmpPath = `${finalPath}.tmp`;
      await runPgDump(tmpPath);
      const data = await fs.readFile(tmpPath);
      await fs.rename(tmpPath, finalPath);

      const secondary = backupSecondaryDir();
      if (secondary) {
        await fs.mkdir(secondary, { recursive: true });
        await fs.copyFile(finalPath, path.join(secondary, artifact), fsConstants.COPYFILE_FICLONE).catch(
          (err) => {
            throw new Error(`secondary copy to ${secondary} failed: ${errText(err)}`);
          },
        );
        await pruneDirectory(secondary, config.localRetention);
      }
      await pruneDirectory(dir, config.localRetention);

      await finishRun(runId, { status: "success", sizeBytes: data.length, sha256: sha256Hex(data) });
      return { status: "ok", runId, artifact, sizeBytes: data.length };
    } catch (err) {
      await finishRun(runId, { status: "failed", error: errText(err) });
      return { status: "failed", error: errText(err) };
    }
  } catch (err) {
    // couldn't even record the run (DB down &c.) — nothing sensible to persist
    console.error(`backup: local run failed to start for business ${businessId}:`, errText(err));
    return { status: "failed", error: errText(err) };
  } finally {
    inFlight.delete(businessId);
  }
}

// ---------------------------------------------------------------------------
// Cloud upload
// ---------------------------------------------------------------------------

export type CloudBackupResult =
  | { status: "ok"; key: string; sizeBytes: number }
  | { status: "disabled" }
  | { status: "failed"; error: string };

/** Encrypt a local artifact and upload it, then prune the bucket prefix. */
export async function runCloudUpload(
  businessId: string,
  artifact: string,
  trigger: RunTrigger,
): Promise<CloudBackupResult> {
  const config = await getBackupConfig(businessId);
  if (!config.cloud.enabled) return { status: "disabled" };

  const key = cloudKeyFor(config.cloud.prefix, artifact);
  const runId = await startRun(businessId, "cloud", trigger, artifact, key);
  try {
    const plain = await fs.readFile(path.join(backupDir(config.directory), artifact));
    const encrypted = encryptBackup(plain, config.cloud.passphrase);
    const s3 = s3ConfigOf(config);
    await s3Put(s3, key, encrypted);

    try {
      const objects = await s3List(s3, config.cloud.prefix);
      for (const stale of selectPrunable(objects.map((o) => o.key), config.cloud.retention)) {
        await s3Delete(s3, stale);
      }
    } catch (err) {
      // pruning is best-effort — the upload itself succeeded
      console.error(`backup: cloud prune failed for business ${businessId}:`, errText(err));
    }

    await finishRun(runId, {
      status: "success",
      sizeBytes: encrypted.length,
      sha256: sha256Hex(encrypted),
    });
    return { status: "ok", key, sizeBytes: encrypted.length };
  } catch (err) {
    await finishRun(runId, { status: "failed", error: errText(err) });
    return { status: "failed", error: errText(err) };
  }
}

/**
 * If the newest successful local artifact never made it to the cloud, try
 * again — but back off CLOUD_RETRY_MS between attempts so an offline café
 * isn't hammering its (dead) uplink every tick.
 */
async function maybeCatchUpCloud(businessId: string, config: BackupConfig): Promise<void> {
  if (!config.cloud.enabled) return;
  const { rows } = await query<{ artifact: string }>(
    `SELECT artifact FROM backup_runs
      WHERE business_id = $1 AND kind = 'local' AND status = 'success'
      ORDER BY started_at DESC LIMIT 1`,
    [businessId],
  );
  const artifact = rows[0]?.artifact;
  if (!artifact) return;

  const { rows: cloudRows } = await query<{ status: string; started_at: Date }>(
    `SELECT status, started_at FROM backup_runs
      WHERE business_id = $1 AND kind = 'cloud' AND artifact = $2
      ORDER BY started_at DESC LIMIT 1`,
    [businessId, artifact],
  );
  const last = cloudRows[0];
  if (last?.status === "success" || last?.status === "running") return;
  if (last && Date.now() - last.started_at.getTime() < CLOUD_RETRY_MS) return;

  await runCloudUpload(businessId, artifact, "scheduled");
}

// ---------------------------------------------------------------------------
// Scheduler tick + manual trigger
// ---------------------------------------------------------------------------

/**
 * Timer entry point (server.ts, every BACKUP_TICK_INTERVAL_MS): for each
 * business, take a backup if a schedule slot has passed uncovered, and keep
 * nudging any not-yet-uploaded artifact toward the cloud.
 */
export async function runBackupTick(): Promise<void> {
  // Enumerating businesses spans tenants; each business's backup then runs
  // scoped to it, so a backup can only ever read its own rows (Phase 12).
  const rows = await withoutTenantScope("platform", async () => {
    const result = await query<{ id: string }>(`SELECT id FROM businesses`, []);
    return result.rows;
  });

  for (const { id: businessId } of rows) {
    try {
      await withTenant(businessId, async () => {
        const config = await getBackupConfig(businessId);
        if (!config.enabled) return;

        const { rows: lastRows } = await query<{ started_at: Date }>(
          `SELECT started_at FROM backup_runs
            WHERE business_id = $1 AND kind = 'local'
            ORDER BY started_at DESC LIMIT 1`,
          [businessId],
        );
        const timeZone = await getBusinessTimezone(businessId);
        if (isBackupDue(lastRows[0]?.started_at ?? null, new Date(), config, timeZone)) {
          const local = await runLocalBackup(businessId, "scheduled");
          if (local.status === "ok" && config.cloud.enabled) {
            await runCloudUpload(businessId, local.artifact, "scheduled");
          }
        } else {
          await maybeCatchUpCloud(businessId, config);
        }
      });
    } catch (err) {
      // never let one business's failure stop the tick
      console.error(`backup tick failed for business ${businessId}:`, errText(err));
    }
  }
}

/** The dashboard's «پشتیبان‌گیری هم‌اکنون»: local backup + cloud upload, one call. */
export async function runBackupNow(
  businessId: string,
): Promise<{ local: LocalBackupResult; cloud: CloudBackupResult }> {
  const local = await runLocalBackup(businessId, "manual");
  const cloud: CloudBackupResult =
    local.status === "ok"
      ? await runCloudUpload(businessId, local.artifact, "manual")
      : { status: "disabled" };
  return { local, cloud };
}

// ---------------------------------------------------------------------------
// Status / health for the dashboard
// ---------------------------------------------------------------------------

export interface BackupRunRow {
  id: string;
  kind: RunKind;
  trigger: RunTrigger;
  status: "running" | "success" | "failed";
  artifact: string | null;
  cloudKey: string | null;
  sizeBytes: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface BackupHealth {
  enabled: boolean;
  cloudEnabled: boolean;
  intervalHours: number;
  localLastSuccessAt: string | null;
  localLastError: string | null;
  cloudLastSuccessAt: string | null;
  cloudLastError: string | null;
  alert: BackupAlert;
}

async function latestRuns(businessId: string, kind: RunKind) {
  const [{ rows: successRows }, { rows: lastRows }] = await Promise.all([
    query<{ finished_at: Date }>(
      `SELECT finished_at FROM backup_runs
        WHERE business_id = $1 AND kind = $2 AND status = 'success'
        ORDER BY started_at DESC LIMIT 1`,
      [businessId, kind],
    ),
    query<{ status: string; error: string | null }>(
      `SELECT status, error FROM backup_runs
        WHERE business_id = $1 AND kind = $2 AND status <> 'running'
        ORDER BY started_at DESC LIMIT 1`,
      [businessId, kind],
    ),
  ]);
  return {
    lastSuccessAt: successRows[0]?.finished_at?.toISOString() ?? null,
    lastError: lastRows[0]?.status === "failed" ? lastRows[0].error : null,
  };
}

export async function getBackupHealth(businessId: string): Promise<BackupHealth> {
  const config = await getBackupConfig(businessId);
  const [local, cloud] = await Promise.all([
    latestRuns(businessId, "local"),
    latestRuns(businessId, "cloud"),
  ]);
  const input = {
    enabled: config.enabled,
    cloudEnabled: config.cloud.enabled,
    intervalHours: config.intervalHours,
    localLastSuccessAt: local.lastSuccessAt,
    localLastError: local.lastError,
    cloudLastSuccessAt: cloud.lastSuccessAt,
    cloudLastError: cloud.lastError,
  };
  return { ...input, alert: computeBackupAlert(input) };
}

export async function listBackupRuns(businessId: string): Promise<BackupRunRow[]> {
  const { rows } = await query<{
    id: string;
    kind: RunKind;
    trigger: RunTrigger;
    status: "running" | "success" | "failed";
    artifact: string | null;
    cloud_key: string | null;
    size_bytes: string | null;
    error: string | null;
    started_at: Date;
    finished_at: Date | null;
  }>(
    `SELECT id, kind, trigger, status, artifact, cloud_key, size_bytes, error,
            started_at, finished_at
       FROM backup_runs WHERE business_id = $1
      ORDER BY started_at DESC LIMIT ${BACKUP_RUNS_SHOWN}`,
    [businessId],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    trigger: r.trigger,
    status: r.status,
    artifact: r.artifact,
    cloudKey: r.cloud_key,
    sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
    error: r.error,
    startedAt: r.started_at.toISOString(),
    finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
  }));
}

// ---------------------------------------------------------------------------
// Restore (whole database) — the dashboard's counterpart of scripts/restore.ts
// ---------------------------------------------------------------------------
//
// The backup artifacts are `pg_dump --format=custom` dumps of the WHOLE
// database, so restoring one replaces every table — every business on the
// install. That is safe exactly when the database holds a single business (a
// desktop/single-tenant install), so `restoreAvailable` gates on that, and the
// UI is hidden anywhere else.
//
// The flow mirrors scripts/restore.ts and its runbook (docs/backup-restore.md):
// the artifact is always restored into a scratch database first and validated
// (migrations + core tables) BEFORE anything destructive; only an explicit
// `apply` then drops and recreates the production database from the same
// already-verified dump. Cloud artifacts are decrypted with the Owner's stored
// passphrase (unlike the CLI, which needs it as an env var because after a
// total machine loss there is no database left to read it from).

const PG_RESTORE_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * A whole-database restore replaces every business on the install, so it is
 * only offered when the database holds exactly one business. Anything else
 * (a central server hosting several tenants) hides the restore UI entirely.
 */
export async function restoreAvailable(): Promise<boolean> {
  const { rows } = await withoutTenantScope("single-tenant-check", () =>
    query<{ n: string }>(`SELECT count(*)::text AS n FROM businesses`, []),
  );
  return Number(rows[0]?.n ?? 0) === 1;
}

export interface RestoreArtifactRow {
  /** local file name, or the object key in the bucket */
  key: string;
  kind: "local" | "cloud";
  sizeBytes: number | null;
  startedAt: string;
  /** false when retention already pruned the artifact — it can no longer be restored */
  exists: boolean;
}

/** Restorable artifacts, one row per successful run, newest first. */
export async function listRestorableArtifacts(
  businessId: string,
): Promise<{ local: RestoreArtifactRow[]; cloud: RestoreArtifactRow[] }> {
  const config = await getBackupConfig(businessId);
  const dir = backupDir(config.directory);
  const { rows } = await query<{
    kind: RunKind;
    artifact: string | null;
    cloud_key: string | null;
    size_bytes: string | null;
    started_at: Date;
  }>(
    `SELECT kind, artifact, cloud_key, size_bytes, started_at
       FROM backup_runs
      WHERE business_id = $1 AND status = 'success'
        AND ((kind = 'local' AND artifact IS NOT NULL) OR (kind = 'cloud' AND cloud_key IS NOT NULL))
      ORDER BY started_at DESC
      LIMIT 100`,
    [businessId],
  );

  // Which cloud objects still exist (retention prunes beyond the keep count).
  // Best-effort: if the bucket is unreachable the run rows still list, and a
  // restore attempt surfaces the real download error.
  const cloudObjects = new Map<string, number>();
  const { endpoint, bucket, accessKeyId, secretAccessKey } = config.cloud;
  if (endpoint && bucket && accessKeyId && secretAccessKey) {
    try {
      for (const object of await s3List(s3ConfigOf(config), config.cloud.prefix)) {
        cloudObjects.set(object.key, object.size);
      }
    } catch (err) {
      console.error(`backup: listing cloud artifacts failed for business ${businessId}:`, errText(err));
    }
  }

  const local: RestoreArtifactRow[] = [];
  const cloud: RestoreArtifactRow[] = [];
  const seenLocal = new Set<string>();
  const seenCloud = new Set<string>();
  for (const row of rows) {
    if (row.kind === "local" && row.artifact && !seenLocal.has(row.artifact)) {
      seenLocal.add(row.artifact);
      let sizeBytes = row.size_bytes === null ? null : Number(row.size_bytes);
      let exists = false;
      try {
        const stat = await fs.stat(path.join(dir, row.artifact));
        exists = true;
        sizeBytes = stat.size;
      } catch {
        // already pruned — keep the row visible so the Owner sees the history,
        // but it cannot be restored anymore
      }
      local.push({
        key: row.artifact,
        kind: "local",
        sizeBytes,
        startedAt: row.started_at.toISOString(),
        exists,
      });
    } else if (row.kind === "cloud" && row.cloud_key && !seenCloud.has(row.cloud_key)) {
      seenCloud.add(row.cloud_key);
      const sizeBytes = cloudObjects.has(row.cloud_key)
        ? cloudObjects.get(row.cloud_key)!
        : row.size_bytes === null
          ? null
          : Number(row.size_bytes);
      cloud.push({
        key: row.cloud_key,
        kind: "cloud",
        sizeBytes,
        startedAt: row.started_at.toISOString(),
        exists: cloudObjects.has(row.cloud_key),
      });
    }
  }
  return { local, cloud };
}

export interface RestoreSummary {
  source: string;
  migrations: number;
  latestMigration: string;
  tables: { name: string; rows: number }[];
}

export type RestoreOutcome =
  | { status: "verified"; summary: RestoreSummary }
  | { status: "applied"; summary: RestoreSummary }
  | { status: "failed"; error: string };

/** One restore in flight per business per process — the same shape as backups. */
const restoreInFlight = new Set<string>();

/** Same server, different database — for admin commands and the scratch restore. */
function withDatabase(databaseUrl: string, dbName: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

async function adminClient(databaseUrl: string): Promise<Client> {
  const client = new Client({ connectionString: withDatabase(databaseUrl, "postgres") });
  await client.connect();
  return client;
}

function runPgRestore(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: PG_RESTORE_TIMEOUT_MS,
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString();
    });
    child.on("error", (err) =>
      reject(new Error(`could not start ${bin}: ${err.message} (set PG_RESTORE_PATH or install postgresql-client)`)),
    );
    child.on("close", (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`${bin} exited with ${signal ?? code}: ${stderr.trim().slice(0, 500)}`));
    });
  });
}

async function validateRestoredDb(databaseUrl: string, source: string): Promise<RestoreSummary> {
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
    for (const name of ["businesses", "locations", "users", "orders", "journal_entries"]) {
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
async function regrantAppRole(databaseUrl: string): Promise<void> {
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
    const { createAppRole } = await import("../../scripts/create-app-role");
    await createAppRole({ databaseUrl, roleName, password, quiet: true });
  } catch (err) {
    console.error(`restore: re-granting app role ${roleName} on the restored database failed:`, errText(err));
  }
}

async function dropDatabase(databaseUrl: string, dbName: string): Promise<void> {
  try {
    const admin = await adminClient(databaseUrl);
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.end();
  } catch (err) {
    console.error(`restore: dropping scratch database ${dbName} failed (best effort):`, errText(err));
  }
}

/**
 * Restore one artifact into a scratch database and validate it — the dry-run
 * half of a restore. Returns the validation summary; never touches production.
 */
async function verifyIntoScratch(
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
 * The dashboard's restore: `apply: false` verifies the artifact into a scratch
 * database and reports the validation summary; `apply: true` replaces the
 * production database — after the same verification — and re-provisions the
 * app role's grants on the fresh database. Owner-only at the route.
 */
export async function restoreFromArtifact(
  businessId: string,
  opts: { source: "local" | "cloud"; artifact: string; apply: boolean },
): Promise<RestoreOutcome> {
  if (restoreInFlight.has(businessId)) return { status: "failed", error: "restore_busy" };
  if (!(await restoreAvailable())) return { status: "failed", error: "restore_not_available" };
  restoreInFlight.add(businessId);
  try {
    const config = await getBackupConfig(businessId);

    // 1. Fetch the artifact bytes (local file or cloud download), decrypt if
    //    the artifact is an encrypted `.dump.enc` (cloud always is).
    let data: Buffer;
    const sourceName = opts.artifact.split("/").at(-1) ?? opts.artifact;
    if (opts.source === "local") {
      // The artifact name arrives in the request body — reject a path before it
      // reaches the filesystem. (The cloud branch takes an object key, where a
      // `/` is the configured prefix and legitimate.)
      if (!isPlainArtifactName(opts.artifact)) {
        return { status: "failed", error: "artifact_not_found" };
      }
      try {
        data = await fs.readFile(path.join(backupDir(config.directory), opts.artifact));
      } catch {
        return { status: "failed", error: "artifact_not_found" };
      }
    } else {
      const s3 = s3ConfigOf(config);
      if (!s3.endpoint || !s3.bucket || !s3.accessKeyId || !s3.secretAccessKey) {
        return { status: "failed", error: "cloud_not_configured" };
      }
      try {
        data = await s3Get(s3, opts.artifact);
      } catch (err) {
        return { status: "failed", error: `download_failed:${errText(err)}` };
      }
    }
    if (isEncryptedBackup(data)) {
      if (!config.cloud.passphrase) return { status: "failed", error: "passphrase_required" };
      try {
        data = decryptBackup(data, config.cloud.passphrase);
      } catch (err) {
        return { status: "failed", error: `decrypt_failed:${errText(err)}` };
      }
    }

    // 2. Write the plaintext dump to a temp file, then restore/verify/apply.
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "pos-restore-"));
    const dumpPath = path.join(workDir, "restore.dump");
    await fs.writeFile(dumpPath, data);

    const databaseUrl = dumpDatabaseUrl();
    const targetDb = new URL(databaseUrl).pathname.replace(/^\//, "") || "pos";
    const scratchDb = `${targetDb}_restore_verify`;
    const pgRestore = process.env.PG_RESTORE_PATH || "pg_restore";

    try {
      // 3. Verify into the scratch database — always, even for an apply.
      const verified = await verifyIntoScratch(databaseUrl, scratchDb, pgRestore, dumpPath, sourceName);

      if (!opts.apply) {
        await dropDatabase(databaseUrl, scratchDb);
        return { status: "verified", summary: verified };
      }

      // 4. Apply: replace the production database with the verified artifact.
      //    WITH (FORCE) terminates the other sessions itself, atomically. Doing
      //    it as a separate pg_terminate_backend leaves a window for the app's
      //    own pool — or a background tick in server.ts — to reconnect before
      //    the DROP lands, and then the DROP fails with "database is being
      //    accessed by other users". (Postgres 13+; this app ships 16.)
      const admin = await adminClient(databaseUrl);
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${targetDb}" WITH (FORCE)`);
        await admin.query(`CREATE DATABASE "${targetDb}"`);
      } finally {
        await admin.end();
      }
      await runPgRestore(pgRestore, ["--no-owner", "--no-privileges", `--dbname=${databaseUrl}`, dumpPath]);
      await regrantAppRole(databaseUrl);
      const summary = await validateRestoredDb(databaseUrl, sourceName);
      await dropDatabase(databaseUrl, scratchDb);
      return { status: "applied", summary };
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    console.error(`restore failed for business ${businessId}:`, errText(err));
    return { status: "failed", error: errText(err) };
  } finally {
    restoreInFlight.delete(businessId);
  }
}
