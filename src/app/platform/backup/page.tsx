/**
 * The super-admin console's full-system backup (migration 0132).
 *
 * Two abilities on one page, because they are one story: the platform backs the
 * whole deployment up on its own schedule, and the artifacts it produces can be
 * handed to — or pulled from — another server by address. The Owner-side backup
 * screen under settings is the per-business view of the same machinery; this one
 * is the operator's, and a restore from here replaces every business on the
 * install, which is exactly why the apply button is behind a typed phrase and an
 * owner-only capability rather than a confirm dialog.
 *
 * Dates on this page are Shamsi like everywhere else in the console (formatJalali
 * through `fmtDate`), and the one English column is the artifact name: it is a
 * file on a disk, quoted verbatim so it can be pasted into `npm run db:restore`.
 */
import { BackupManager } from "./backup-manager";

export default function PlatformBackupPage() {
  return <BackupManager />;
}
