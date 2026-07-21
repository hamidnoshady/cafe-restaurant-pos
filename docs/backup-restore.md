# Backup & Restore Runbook (Phase 10)

How backups work, and — step by step — how to restore a location's database
from a local or cloud artifact. Every procedure here is also automated by
`scripts/restore.ts` (`npm run db:restore`), which always dry-runs into a
scratch database before anything destructive.

## What a backup is

- A **`pg_dump --format=custom`** of the **whole local PostgreSQL database**
  (all phases, all tables — orders, ledger, inventory, reservations,
  settings, …). One artifact per run, named
  `pos-backup-YYYYMMDD-HHMMSS.dump` (UTC stamp, sorts chronologically).
- **Local**: written to `BACKUP_DIR` (default `./backups` next to the app).
  If `BACKUP_SECONDARY_DIR` is set (mounted USB drive / NAS), each artifact
  is also copied there — and a failed copy fails the run, so an unplugged
  drive raises the dashboard alert instead of silently degrading.
- **Cloud**: the same artifact, **encrypted** with the Owner's passphrase
  (AES-256-GCM, scrypt key derivation), uploaded as
  `<prefix>pos-backup-….dump.enc` to any S3-compatible storage (ArvanCloud,
  AWS S3, Backblaze B2, a MinIO on a NAS, …). The provider only ever holds
  ciphertext. Uploads that fail (no internet at backup time) are retried
  automatically until a newer artifact supersedes them.
- **Schedule/retention** are configured by the Owner on
  `/dashboard/backup`; artifacts beyond the retention count are pruned
  automatically on both sides. Run history is in the `backup_runs` table and
  on the dashboard; a failed or overdue backup shows a red alert on the main
  Owner dashboard within one interval + grace (nightly ⇒ within 30h).
- The Phase 9 **central aggregation server is just another deployment of
  this app**, so it gets the exact same backup system — enable it on the
  central instance's own dashboard too.

## Key management (read this before you need it)

Cloud artifacts are unrecoverable without the encryption passphrase. Keep it:

1. In the Owner's password manager, **and**
2. On paper (sealed envelope) wherever the business keeps its other
   critical documents — so a restore is possible even if the primary Owner
   is unreachable.

The S3 credentials should likewise be stored outside the POS machine — after
a total machine loss, the dashboard settings (which live in the database) are
gone with it; restore then needs the passphrase + S3 credentials from that
envelope/password manager.

## Restore, step by step

Prerequisites: a machine with this repo, Node ≥ 20, `pg_restore`
(postgresql-client 16+), and a running PostgreSQL 16 server (the
docker-compose one is fine). `DATABASE_URL` in `.env` must point at the
target server.

### A. From a local artifact

```bash
# 1. Dry run — restores into a scratch DB (pos_restore_verify) and
#    validates; the production DB is NOT touched:
npm run db:restore -- backups/pos-backup-20260721-033001.dump

# 2. Read the validation output (migration count, row counts for
#    businesses/locations/users/orders/journal_entries). If it looks right:

# 3. Stop the app (the restore terminates open DB connections), then:
npm run db:restore -- backups/pos-backup-20260721-033001.dump --apply --yes

# 4. Start the app, log in, and spot-check: today's orders list, ledger
#    trial balance, inventory levels.
```

`--apply` re-verifies into the scratch DB first and only then drops and
recreates the production database from the artifact. `--yes` is required —
there is no interactive prompt to fat-finger.

### B. From a cloud artifact

```bash
# 1. Credentials + passphrase come from env (no DB to read settings from):
export BACKUP_S3_ENDPOINT=https://s3.ir-thr-at1.arvanstorage.ir
export BACKUP_S3_BUCKET=my-cafe-backups
export BACKUP_S3_ACCESS_KEY_ID=…
export BACKUP_S3_SECRET_ACCESS_KEY=…
export BACKUP_PASSPHRASE='the passphrase from the sealed envelope'

# 2. Dry run (downloads, decrypts, scratch-verifies):
npm run db:restore -- --from-cloud pos-backups/pos-backup-20260721-033001.dump.enc

# 3. Apply, same as the local flow:
npm run db:restore -- --from-cloud pos-backups/pos-backup-20260721-033001.dump.enc --apply --yes
```

Don't know the newest key? Any S3 browser works, or take the newest
`cloud_key` from the dashboard's run history (if the machine still lives).

You can also restore a manually-downloaded `.dump.enc` as a local file —
`isEncryptedBackup` detection is automatic; only `BACKUP_PASSPHRASE` is
needed.

### C. Bare-metal recovery (machine completely lost)

1. New machine: install Docker + Node, clone this repo, `npm install`,
   `docker compose up -d`, `cp .env.example .env`.
2. Do **not** run migrations or the seed — the restore brings the whole
   schema and data.
3. Follow **B** (cloud restore). The scratch database is created on the
   fresh server automatically; `--apply --yes` then creates the production
   database from the artifact.
4. Start the app (`npm run dev` / `npm start`), log in with the same
   credentials as before (they're in the backup), re-check
   `/dashboard/backup` — schedule/cloud settings restored with everything
   else; take a fresh manual backup to prove the new machine can.

### Notes

- **What a restore loses:** everything after the artifact's timestamp — the
  schedule (default nightly) bounds the worst case; raise the frequency on
  `/dashboard/backup` if a day is too much (see the phase doc's RPO
  decision).
- The scratch database is dropped automatically after verification
  (`--keep-scratch` keeps it for inspection).
- A restore is all-or-nothing per database: there is no partial/table-level
  restore in this phase, and no point-in-time recovery (full-backup based,
  PITR flagged as a future enhancement).
- Version rule: run `pg_restore` of the **same or newer** major version as
  the PostgreSQL server that produced the dump (both are 16 here).
