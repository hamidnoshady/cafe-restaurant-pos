-- runServerPull (src/lib/server-sync.ts) replays each event it pulls from the
-- remote via applySyncEvent(), and deliberately keeps going past one that
-- throws (a single malformed/poison event shouldn't block every event behind
-- it in the batch) — but until now that just logged to stderr, and the
-- high-water mark still advanced past it, so the event was silently dropped
-- forever with no way to see it happened or replay it. This table makes that
-- visible and gives an operator something to act on.

CREATE TABLE server_sync_dead_letters (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- Not FK'd to sync_events/locations: a poison event's location_id or
    -- client_event_id may itself be malformed, and this table exists
    -- specifically to capture that rather than fail on it.
    remote_event_id bigint NOT NULL,
    location_id     text NOT NULL,
    client_event_id text NOT NULL,
    event_type      text NOT NULL,
    payload         jsonb NOT NULL,
    error           text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_server_sync_dead_letters_business ON server_sync_dead_letters (business_id, created_at DESC);

ALTER TABLE server_sync_dead_letters ENABLE ROW LEVEL SECURITY;
ALTER TABLE server_sync_dead_letters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON server_sync_dead_letters FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
