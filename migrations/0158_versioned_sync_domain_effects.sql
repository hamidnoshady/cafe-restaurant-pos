-- 0158_versioned_sync_domain_effects.sql
-- Transactional, versioned domain-event application and operator-safe sync diagnostics.
-- Tables/balances/current stock are never synchronized directly: one inbox row
-- maps to one explicit domain service effect, recorded under a business-scoped
-- idempotency key in the same transaction as that effect.

ALTER TABLE sync_events
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ADD COLUMN last_attempt_at timestamptz,
  ADD COLUMN deferred_until timestamptz,
  ADD COLUMN dead_lettered_at timestamptz;

CREATE INDEX idx_sync_events_deferred
  ON sync_events (deferred_until, id)
  WHERE applied_at IS NULL AND error IS NULL AND deferred_until IS NOT NULL;

CREATE TABLE sync_domain_effects (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id         uuid NOT NULL,
    site_device_id      uuid,
    client_event_id     uuid NOT NULL,
    event_type          text NOT NULL,
    schema_version      integer NOT NULL CHECK (schema_version > 0),
    status              text NOT NULL CHECK (status IN ('deferred', 'applied', 'dead_lettered')),
    effect_type         text,
    effect_id           text,
    result              jsonb,
    error_code          text,
    attempts            integer NOT NULL DEFAULT 1 CHECK (attempts > 0),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    applied_at          timestamptz,
    CONSTRAINT sync_domain_effects_location_business_fk
      FOREIGN KEY (location_id, business_id) REFERENCES locations(id, business_id) ON DELETE CASCADE,
    CONSTRAINT sync_domain_effects_device_business_fk
      FOREIGN KEY (site_device_id, business_id) REFERENCES site_devices(id, business_id) ON DELETE RESTRICT,
    CONSTRAINT sync_domain_effects_event_unique UNIQUE (business_id, client_event_id)
);
CREATE INDEX idx_sync_domain_effects_status
  ON sync_domain_effects (business_id, status, updated_at DESC);
CREATE INDEX idx_sync_domain_effects_entity
  ON sync_domain_effects (business_id, effect_type, effect_id)
  WHERE effect_id IS NOT NULL;

CREATE TABLE sync_event_dead_letters (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id         uuid,
    site_device_id      uuid,
    client_event_id     text NOT NULL,
    event_type          text NOT NULL,
    schema_version      integer,
    payload_sha256      text NOT NULL CHECK (char_length(payload_sha256) = 64),
    error_code          text NOT NULL,
    status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'discarded')),
    retry_count         integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    first_seen_at       timestamptz NOT NULL DEFAULT now(),
    last_seen_at        timestamptz NOT NULL DEFAULT now(),
    resolved_at         timestamptz,
    resolved_by         uuid REFERENCES users(id) ON DELETE SET NULL,
    resolution_note     text,
    CONSTRAINT sync_event_dead_letters_location_business_fk
      FOREIGN KEY (location_id, business_id) REFERENCES locations(id, business_id) ON DELETE CASCADE,
    CONSTRAINT sync_event_dead_letters_device_business_fk
      FOREIGN KEY (site_device_id, business_id) REFERENCES site_devices(id, business_id) ON DELETE RESTRICT,
    CONSTRAINT sync_event_dead_letters_identity_unique
      UNIQUE (business_id, client_event_id, event_type, schema_version)
);
CREATE INDEX idx_sync_event_dead_letters_open
  ON sync_event_dead_letters (business_id, last_seen_at DESC)
  WHERE status = 'open';

ALTER TABLE sync_domain_effects ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_domain_effects FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sync_domain_effects FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE sync_event_dead_letters ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_event_dead_letters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sync_event_dead_letters FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
