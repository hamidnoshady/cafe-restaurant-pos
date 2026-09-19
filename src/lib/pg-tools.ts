/**
 * The two Postgres client binaries the backup and restore pipelines spawn.
 *
 * Both live in one file because both are "run a native tool the host may not
 * have on PATH, and turn its exit status into a useful error": `pg_dump` for
 * taking an artifact (`backup-service.ts`, and the console's whole-system
 * backup), `pg_restore` for putting one back (`restore-engine.ts`).
 *
 * The binaries are resolved from `PG_DUMP_PATH` / `PG_RESTORE_PATH` rather than
 * hard-coded, for three reasons that all show up in the field:
 *
 *   • the container image ships `postgresql-client` from Debian while the
 *     server may be a major version ahead, and `pg_restore` must be **the same
 *     or newer** than the `pg_dump` that produced the file (see
 *     docs/backup-restore.md's version rule);
 *   • the standalone desktop app bundles its Postgres inside the app directory,
 *     so the tools are not on PATH at all;
 *   • a test can point them at a stub and drive the whole pipeline without a
 *     client install — which is exactly what
 *     integration/platform-system-backup.integration.test.ts does.
 */
import { spawn, type SpawnOptions } from "node:child_process";

/**
 * Windows cannot `CreateProcess` a `.cmd`/`.bat` — those are interpreted by
 * `cmd.exe`, so a direct `spawn()` of one fails with ENOENT. Both binaries are
 * resolved from an operator-supplied path (and the desktop build, plus the
 * integration test's stub, legitimately point at a batch wrapper), so route
 * those through a shell. Everything else is spawned directly, which keeps the
 * normal case free of shell quoting entirely.
 */
function spawnOptionsFor(bin: string): SpawnOptions {
  const isBatch = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin.trim());
  return {
    stdio: ["ignore", "ignore", "pipe"],
    shell: isBatch,
  };
}

/** A large database on slow disk can outlast a naive timeout; 15 min is the tenant-side figure this has always used. */
export const PG_DUMP_TIMEOUT_MS = 15 * 60 * 1000;
export const PG_RESTORE_TIMEOUT_MS = 15 * 60 * 1000;

export function pgDumpBin(env: Partial<NodeJS.ProcessEnv> = process.env): string {
  return env.PG_DUMP_PATH?.trim() || "pg_dump";
}

export function pgRestoreBin(env: Partial<NodeJS.ProcessEnv> = process.env): string {
  return env.PG_RESTORE_PATH?.trim() || "pg_restore";
}

/**
 * `pg_dump --format=custom` of a whole database into `outFile`.
 *
 * The RLS hint is the part worth keeping: the app's own connection is the
 * restricted `pos_app` role, and pg_dump run as that role aborts on the first
 * COPY with `query would be affected by row-level security policy for table
 * "…"`. The raw message tells an operator nothing about what to change, so the
 * error names the variable that is wrong — see `dumpDatabaseUrl()` in
 * backup.ts for the full reasoning.
 */
export function runPgDump(
  outFile: string,
  databaseUrl: string,
  bin = pgDumpBin(),
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["--format=custom", "--no-password", `--file=${outFile}`, databaseUrl], {
      ...spawnOptionsFor(bin),
      timeout: PG_DUMP_TIMEOUT_MS,
    });
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString();
    });
    child.on("error", (err) =>
      reject(new Error(`could not start ${bin}: ${err.message} (set PG_DUMP_PATH or install postgresql-client)`)),
    );
    child.on("close", (code, signal) => {
      if (code === 0) return resolve();
      const hint = /row-level security/.test(stderr)
        ? " — pg_dump must connect as the privileged (migration/owner) role; point BACKUP_DATABASE_URL at it"
        : "";
      reject(new Error(`pg_dump exited with ${signal ?? code}: ${stderr.trim().slice(0, 500)}${hint}`));
    });
  });
}

/** `pg_restore` with caller-supplied arguments (the engine always passes `--no-owner --no-privileges`). */
export function runPgRestore(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      ...spawnOptionsFor(bin),
      timeout: PG_RESTORE_TIMEOUT_MS,
    });
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => {
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
