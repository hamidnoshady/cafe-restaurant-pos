-- 0018_server_sync.sql — bidirectional server-to-server sync (Phase 11)
--
-- Adds the infrastructure for a café laptop (local server) to sync
-- live transactional events with the VPS in both directions.
--
-- Design:
--   * server_sync_config  — stored per-business in settings (JSON), not a table.
--   * server_sync_log     — one row per push/pull attempt; used for status UI
--                           and to track the high-water mark for each direction.
--   * The existing sync_events table (client→server idempotency) is reused
--     for server→server replay: the remote server sends events with the same
--     client_event_id scheme, so the UNIQUE(location_id, client_event_id)
--     constraint deduplicates them automatically.

CREATE TABLE IF NOT EXISTS server_sync_log (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    direction       text NOT NULL CHECK (direction IN ('push', 'pull')),
    status          text NOT NULL CHECK (status IN ('ok', 'error', 'skipped')),
    events_count    int NOT NULL DEFAULT 0,
    error           text,
    attempted_at    timestamptz NOT NULL DEFAULT now(),
    -- high-water mark: last sync_events.id successfully pushed/pulled
    last_event_id   bigint
);

CREATE INDEX idx_server_sync_log_business ON server_sync_log (business_id, direction, attempted_at DESC);

-- Extend sync_events with actor identity and origin so server-to-server
-- sync can replay events with the correct actor and skip re-pushing events
-- that arrived from the remote (origin = 'remote').
ALTER TABLE sync_events
  ADD COLUMN IF NOT EXISTS actor_user_id text,
  ADD COLUMN IF NOT EXISTS actor_role    text,
  ADD COLUMN IF NOT EXISTS origin        text NOT NULL DEFAULT 'local'
    CHECK (origin IN ('local', 'remote'));
