/**
 * Database backup: dumps the whole Postgres database (schema + data) to a
 * timestamped file, then prunes old backups beyond the retention count.
 *
 * The database is the business's system of record — sales, the double-entry
 * ledger, inventory, tax. On a single on-site till PC that is one disk away
 * from total loss, so run this on a schedule and, crucially, point BACKUP_DIR
 * at a SEPARATE disk (a mounted USB stick, a second drive, or a LAN share) —
 * a backup on the same disk that fails doesn't help. See the README «پشتیبان‌گیری».
 *
 * Usage:  npm run db:backup
 * Env:
 *   DATABASE_URL       (required) same connection the app uses
 *   BACKUP_DIR         where to write dumps (default ./backups) — set to your USB/second-disk mount
 *   BACKUP_RETENTION   how many newest dumps to keep (default 14; <1 keeps all)
 *
 * Requires the Postgres client tools (pg_dump) on PATH — same major version
 * as the server (16). If the DB runs only in Docker, either install the
 * client, or dump via: docker compose exec -T db pg_dump ... (see README).
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { backupFilename, selectBackupsToPrune } from "../src/lib/backup";

function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env first.");
    process.exit(1);
  }

  const backupDir = process.env.BACKUP_DIR?.trim() || join(process.cwd(), "backups");
  const retention = process.env.BACKUP_RETENTION ? Number(process.env.BACKUP_RETENTION) : 14;
  if (Number.isNaN(retention)) {
    console.error(`BACKUP_RETENTION must be a number, got "${process.env.BACKUP_RETENTION}".`);
    process.exit(1);
  }

  try {
    mkdirSync(backupDir, { recursive: true });
  } catch (err) {
    console.error(`Cannot create BACKUP_DIR "${backupDir}":`, err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const filename = backupFilename(new Date());
  const finalPath = join(backupDir, filename);
  const partialPath = `${finalPath}.partial`;

  // -Fc: compressed custom format (restore with pg_restore). --no-owner/--no-privileges
  // keep the dump portable across roles (restore into `pos` regardless of who dumped).
  process.stdout.write(`Backing up → ${finalPath} … `);
  const result = spawnSync(
    "pg_dump",
    [databaseUrl, "-Fc", "--no-owner", "--no-privileges", "-f", partialPath],
    { stdio: ["ignore", "inherit", "inherit"] },
  );

  if (result.error) {
    console.log("FAILED");
    rmSync(partialPath, { force: true });
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(
        "pg_dump not found on PATH. Install the PostgreSQL 16 client tools, " +
          "or dump via Docker (see the README «پشتیبان‌گیری» section).",
      );
    } else {
      console.error(result.error.message);
    }
    process.exit(1);
  }
  if (result.status !== 0) {
    console.log("FAILED");
    rmSync(partialPath, { force: true });
    console.error(`pg_dump exited with code ${result.status}.`);
    process.exit(1);
  }

  // Only a fully-written dump gets the real name — a crash mid-dump leaves a
  // .partial that's obviously not a valid backup and is never restored/kept.
  renameSync(partialPath, finalPath);
  const sizeMb = (statSync(finalPath).size / (1024 * 1024)).toFixed(2);
  console.log(`ok (${sizeMb} MB)`);

  const pruned = selectBackupsToPrune(readdirSync(backupDir), retention);
  for (const name of pruned) rmSync(join(backupDir, name), { force: true });
  if (pruned.length > 0) {
    console.log(`Pruned ${pruned.length} old backup(s), keeping the newest ${retention}.`);
  }
}

main();
