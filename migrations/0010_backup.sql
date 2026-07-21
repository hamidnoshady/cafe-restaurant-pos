-- ============================================================================
-- 0010_backup.sql — Phase 10 (Backup System: Local + Cloud)
--
-- Run history for scheduled/manual backups. The backup artifact itself is a
-- `pg_dump --format=custom` of the WHOLE local database (every table, all
-- phases), written to local disk and — optionally, encrypted — uploaded to
-- S3-compatible cloud storage. Schedule/retention/cloud settings live in the
-- `settings` KV table (key `backup.config`, Owner-editable); this table is
-- only the audit trail the dashboard's health view and alerts read from.
--
-- A "cloud" row references the same artifact as the "local" row that produced
-- it (`artifact` = local file name; `cloud_key` = the object key it was
-- uploaded under). A failed cloud upload is retried on later scheduler ticks
-- until a newer local artifact supersedes it, so a backup taken while the
-- internet is down still reaches the cloud once connectivity returns.
-- ============================================================================

CREATE TABLE backup_runs (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    kind         text NOT NULL CHECK (kind IN ('local', 'cloud')),
    trigger      text NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
    status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'failed')),
    artifact     text,                 -- local artifact file name (both kinds)
    cloud_key    text,                 -- object key in the bucket (cloud rows only)
    size_bytes   bigint,               -- artifact size (cloud rows: encrypted size)
    sha256       text,                 -- artifact checksum (cloud rows: of the encrypted object)
    error        text,                 -- failure detail (status = 'failed')
    started_at   timestamptz NOT NULL DEFAULT now(),
    finished_at  timestamptz
);

CREATE INDEX idx_backup_runs_business_kind_time
    ON backup_runs (business_id, kind, started_at DESC);
