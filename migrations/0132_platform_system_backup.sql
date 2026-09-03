-- ============================================================================
-- 0132_platform_system_backup.sql — the super-admin's full-system backup.
--
-- Phase 10 gave every *business* a backup of its own, configured on
-- /dashboard/settings?tab=backup. That system dumps the whole local database
-- (a single-install app cannot dump half of it), but it is owned, scheduled,
-- alert-pruned and restored per tenant — which is the right shape for the
-- desktop install and the wrong one for the platform operator, who is
-- responsible for the *deployment*: every business on this server, the
-- platform realm (admins, audit log, billing catalogue, knowledge base) and
-- the schema/migration state itself.
--
-- This migration adds the platform realm's own backup half, in exactly the
-- shape the console already stores its other deployment-wide singletons
-- (`platform_payment_config`, `platform_sms_config`, `platform_update_config`
-- — see 0038 / 0076 / 0130): a one-row config the super-admin edits, a run
-- history, and — the new part — the two tables that make an artifact
-- transferable between servers:
--
--   platform_backup_config   the whole-system backup settings, owned by the
--                            console: schedule, retention, destinations,
--                            encryption passphrase, cloud mirror, and whether
--                            this server will hand its artifacts to another
--                            server over the network ("serving").
--   platform_backup_runs     one row per backup (local dump, cloud upload),
--                            with the *manifest* that artifact was taken with:
--                            app version, migration count, server version,
--                            business/table counts. The manifest is what a new
--                            server checks before it dares to restore.
--   platform_backup_tokens   hashed bearer credentials a peer server presents
--                            to THIS server's /api/peer/backup/* endpoints.
--                            Stored hashed (sha256) exactly like
--                            `server_sync_tokens` (0033): a leaked table dump
--                            must not hand over working access.
--   platform_backup_peers    the servers THIS install may pull backups *from*
--                            — the address + token that turns "restore the old
--                            server's backup on the new one" into a form
--                            submission instead of a CLI runbook.
--   platform_restore_runs    one row per verify/apply, from any source, so a
--                            restore is always attributable and the console can
--                            show what replaced the database and when.
--
-- None of these carry a business_id: they belong to the deployment, not to a
-- tenant, so they are deliberately outside RLS — the same reasoning, spelled
-- out in 0021 and repeated by every `platform_*` row above, and mirrored in
-- src/lib/tenant-tables.ts's EXEMPT_TABLES (which
-- integration/tenant-isolation.integration.test.ts pins).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- The whole-system backup configuration (one row, edited in the console)
-- ---------------------------------------------------------------------------
CREATE TABLE platform_backup_config (
    id                    boolean PRIMARY KEY DEFAULT true CHECK (id),

    -- Schedule. Same vocabulary as the tenant config (src/lib/backup.ts):
    -- slots are anchor + k·interval, evaluated on this wall clock below.
    enabled               boolean NOT NULL DEFAULT false,
    interval_hours        integer NOT NULL DEFAULT 24
                              CHECK (interval_hours IN (1, 2, 3, 4, 6, 8, 12, 24)),
    anchor_time           text NOT NULL DEFAULT '03:30'
                              CHECK (anchor_time ~ '^([01][0-9]|2[0-3]):([0-5][0-9])$'),
    -- The zone the anchor time is a wall clock IN. A platform operator running
    -- a Tehran-hosted fleet keeps "03:30 nightly" meaningful by leaving this at
    -- the default; it is a config field rather than a hard-coded zone because
    -- the deployment may serve several zones at once.
    timezone              text NOT NULL DEFAULT 'Asia/Tehran',

    -- Destinations. Empty directory = BACKUP_DIR / ./backups, so an existing
    -- install keeps its artifacts where they already are.
    directory             text NOT NULL DEFAULT '',
    secondary_directory   text NOT NULL DEFAULT '',
    local_retention       integer NOT NULL DEFAULT 14
                              CHECK (local_retention BETWEEN 1 AND 365),

    -- Encryption. Local artifacts are encrypted too (Phase 24's rule for the
    -- tenant backups) so a stolen backup drive is not a stolen ledger.
    encrypt_local         boolean NOT NULL DEFAULT true,
    passphrase            text NOT NULL DEFAULT '',

    -- Cloud mirror (S3-compatible). The prefix defaults apart from the tenant
    -- one so a bucket shared between both halves cannot collide.
    cloud_enabled         boolean NOT NULL DEFAULT false,
    cloud_endpoint        text NOT NULL DEFAULT '',
    cloud_region          text NOT NULL DEFAULT 'us-east-1',
    cloud_bucket          text NOT NULL DEFAULT '',
    cloud_prefix          text NOT NULL DEFAULT 'platform-backups/',
    cloud_access_key_id   text NOT NULL DEFAULT '',
    cloud_secret_access_key text NOT NULL DEFAULT '',
    cloud_retention       integer NOT NULL DEFAULT 30
                              CHECK (cloud_retention BETWEEN 1 AND 365),

    -- Serving: does this machine hand its artifacts to another server that
    -- presents a valid token? Off by default — an unlisted, always-on export
    -- of the whole platform's data is not something to enable by accident.
    serving_enabled       boolean NOT NULL DEFAULT false,
    -- Peer addresses must be https unless this is turned on, which is the
    -- operator's way of saying "the address I typed is a machine on my own
    -- network, and plain http is what it speaks".
    allow_insecure_peers  boolean NOT NULL DEFAULT false,

    updated_by            uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    updated_at            timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform_backup_config (id) VALUES (true);

-- ---------------------------------------------------------------------------
-- Run history
-- ---------------------------------------------------------------------------
CREATE TABLE platform_backup_runs (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind          text NOT NULL CHECK (kind IN ('local', 'cloud')),
    trigger       text NOT NULL CHECK (trigger IN ('scheduled', 'manual', 'peer')),
    status        text NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'success', 'failed')),
    artifact      text,
    cloud_key     text,
    size_bytes    bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
    sha256        text,
    error         text,
    -- What this artifact holds, as taken at dump time (app version, migration
    -- count, server version, row counts). The serve endpoint replays it to a
    -- peer, which is how a new server knows what it is about to restore
    -- before it restores anything.
    manifest      jsonb,
    created_by    uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    started_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz
);
CREATE INDEX idx_platform_backup_runs_started
    ON platform_backup_runs (started_at DESC);
CREATE INDEX idx_platform_backup_runs_kind_started
    ON platform_backup_runs (kind, started_at DESC);

-- ---------------------------------------------------------------------------
-- Serve-side credentials (hashed at rest)
-- ---------------------------------------------------------------------------
CREATE TABLE platform_backup_tokens (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    label         text NOT NULL CHECK (length(trim(label)) > 0),
    token_hash    text NOT NULL UNIQUE,
    -- The tail of the token, for telling two of them apart on screen. Never
    -- anything a caller could use.
    token_hint    text NOT NULL,
    created_by    uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_used_at  timestamptz,
    uses          integer NOT NULL DEFAULT 0,
    -- NULL = never expires. A token handed to a migration that is "just for
    -- this weekend" should expire, so it can't outlive the weekend.
    expires_at    timestamptz,
    revoked_at    timestamptz
);
CREATE INDEX idx_platform_backup_tokens_active
    ON platform_backup_tokens (revoked_at, expires_at);

-- ---------------------------------------------------------------------------
-- Pull-side peers (servers this install may restore FROM)
-- ---------------------------------------------------------------------------
CREATE TABLE platform_backup_peers (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    label          text NOT NULL CHECK (length(trim(label)) > 0),
    -- Origin only — scheme://host[:port], no path, no credentials in it. The
    -- pure half (src/lib/platform-backup.ts) normalizes and validates it; this
    -- is a CHECK so a hand-edited row can't smuggle a path past that.
    base_url       text NOT NULL CHECK (base_url ~ '^https?://[^/?#@]+(/[^/?#@]*)?$'),
    -- The credential we present to that server, in POS1-… form. Unlike
    -- platform_backup_tokens (which only ever *verifies* what a peer presents,
    -- so a hash is enough), this half has to send the secret on every request,
    -- so it is stored in the clear — the same trade `server_sync_tokens`'
    -- counterpart in the settings table makes.
    token          text NOT NULL DEFAULT '',
    enabled        boolean NOT NULL DEFAULT true,
    -- Last successful handshake, for the console's "is this still working?"
    -- column, and the failure when it isn't.
    last_check_at  timestamptz,
    last_check_status text,
    last_error     text,
    created_by     uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_platform_backup_peers_label ON platform_backup_peers (lower(label));

-- ---------------------------------------------------------------------------
-- Restore history (verify + apply, from any source)
-- ---------------------------------------------------------------------------
CREATE TABLE platform_restore_runs (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source      text NOT NULL CHECK (source IN ('local', 'cloud', 'peer', 'url')),
    peer_id     uuid REFERENCES platform_backup_peers(id) ON DELETE SET NULL,
    artifact    text NOT NULL,
    mode        text NOT NULL CHECK (mode IN ('verify', 'apply')),
    status      text NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'success', 'failed')),
    -- The validation summary: migrations, latest migration, core row counts.
    summary     jsonb,
    error       text,
    created_by  uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    started_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
);
CREATE INDEX idx_platform_restore_runs_started
    ON platform_restore_runs (started_at DESC);
