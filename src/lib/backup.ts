/**
 * Pure helpers for the database backup/restore scripts (scripts/backup.ts,
 * scripts/restore.ts). Framework-free and DB-free, so they're unit-tested
 * here; the scripts themselves shell out to pg_dump/pg_restore and aren't
 * (same split as scripts/migrate.ts vs. the *.test.ts'd lib).
 *
 * Backup filenames embed a UTC timestamp — storage is ISO/UTC everywhere in
 * this project (Jalali/local is display-only), and UTC keeps the name
 * unambiguous across DST and machine-timezone changes on the till PC.
 */

export const BACKUP_PREFIX = "pos-backup-";
/** pg_dump custom format (-Fc): compressed, restored with pg_restore. */
export const BACKUP_EXT = ".dump";

const FILENAME_RE = /^pos-backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.dump$/;

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** e.g. 2026-07-21T18:30:45Z → "pos-backup-20260721-183045.dump" (UTC components). */
export function backupFilename(date: Date): string {
  const stamp =
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
  return `${BACKUP_PREFIX}${stamp}${BACKUP_EXT}`;
}

/** Inverse of backupFilename; null when the name isn't one of our backups or encodes an impossible date. */
export function parseBackupTimestamp(filename: string): Date | null {
  const m = FILENAME_RE.exec(filename);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  // Reject values that rolled over (e.g. month 13, day 32).
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d ||
    date.getUTCHours() !== h ||
    date.getUTCMinutes() !== mi ||
    date.getUTCSeconds() !== s
  ) {
    return null;
  }
  return date;
}

export function isBackupFilename(filename: string): boolean {
  return parseBackupTimestamp(filename) !== null;
}

/**
 * Given the filenames in a backup directory and how many newest to keep,
 * return the ones to delete (oldest first). Files that aren't our backups
 * are ignored — never returned for deletion. `keep < 1` prunes nothing (the
 * safe direction: a misconfigured retention must never wipe every backup).
 */
export function selectBackupsToPrune(filenames: string[], keep: number): string[] {
  if (keep < 1) return [];
  const backups = filenames
    .map((name) => ({ name, at: parseBackupTimestamp(name) }))
    .filter((b): b is { name: string; at: Date } => b.at !== null)
    .sort((a, b) => b.at.getTime() - a.at.getTime()); // newest first
  return backups.slice(keep).map((b) => b.name);
}
