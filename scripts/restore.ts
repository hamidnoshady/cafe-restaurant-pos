/**
 * Database restore: loads a backup produced by scripts/backup.ts back into
 * the database in DATABASE_URL.
 *
 * THIS IS DESTRUCTIVE. pg_restore --clean drops and recreates the existing
 * objects, so restoring replaces whatever is currently in the target
 * database with the backup's contents. It therefore refuses to run unless
 * you explicitly confirm with --yes (or RESTORE_CONFIRM=1).
 *
 * Usage:
 *   npm run db:restore -- --latest           # newest dump in BACKUP_DIR
 *   npm run db:restore -- ./backups/pos-backup-20260721-183045.dump
 *   npm run db:restore -- --latest --yes     # actually run it
 * Env:
 *   DATABASE_URL       (required) target database (data here is REPLACED)
 *   BACKUP_DIR         where --latest looks (default ./backups)
 *   RESTORE_CONFIRM=1  same as passing --yes
 *
 * Requires pg_restore on PATH (PostgreSQL 16 client tools).
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseBackupTimestamp } from "../src/lib/backup";

function latestBackup(backupDir: string): string | null {
  if (!existsSync(backupDir)) return null;
  const newest = readdirSync(backupDir)
    .map((name) => ({ name, at: parseBackupTimestamp(name) }))
    .filter((b): b is { name: string; at: Date } => b.at !== null)
    .sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  return newest ? join(backupDir, newest.name) : null;
}

function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env first.");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const confirmed = args.includes("--yes") || process.env.RESTORE_CONFIRM === "1";
  const useLatest = args.includes("--latest");
  const backupDir = process.env.BACKUP_DIR?.trim() || join(process.cwd(), "backups");
  const explicitPath = args.find((a) => !a.startsWith("--"));

  let file: string | null;
  if (useLatest) {
    file = latestBackup(backupDir);
    if (!file) {
      console.error(`No backups found in "${backupDir}". Nothing to restore.`);
      process.exit(1);
    }
  } else if (explicitPath) {
    file = explicitPath;
  } else {
    console.error(
      "Specify a dump file, or --latest.\n" +
        "  npm run db:restore -- --latest --yes\n" +
        "  npm run db:restore -- ./backups/pos-backup-YYYYMMDD-HHMMSS.dump --yes",
    );
    process.exit(1);
  }

  if (!existsSync(file)) {
    console.error(`Backup file not found: ${file}`);
    process.exit(1);
  }

  if (!confirmed) {
    // Redact credentials before echoing the target.
    const target = databaseUrl.replace(/\/\/[^@]*@/, "//***@");
    console.error(
      "Refusing to restore without confirmation.\n\n" +
        `  This REPLACES all data in: ${target}\n` +
        `  with the contents of:      ${file}\n\n` +
        "Re-run with --yes (or RESTORE_CONFIRM=1) once you're sure.",
    );
    process.exit(1);
  }

  process.stdout.write(`Restoring ${file} → database … `);
  const result = spawnSync(
    "pg_restore",
    ["--clean", "--if-exists", "--no-owner", "--no-privileges", "-d", databaseUrl, file],
    { stdio: ["ignore", "inherit", "inherit"] },
  );

  if (result.error) {
    console.log("FAILED");
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error("pg_restore not found on PATH. Install the PostgreSQL 16 client tools.");
    } else {
      console.error(result.error.message);
    }
    process.exit(1);
  }
  if (result.status !== 0) {
    console.log("FAILED");
    console.error(`pg_restore exited with code ${result.status}.`);
    process.exit(1);
  }
  console.log("ok");
  console.log("Restore complete. Restart the app so it reconnects cleanly.");
}

main();
