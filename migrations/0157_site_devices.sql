-- 0157_site_devices.sql — independent, revocable Windows site identities.
--
-- A business-wide server_sync_tokens row can represent only one laptop and
-- cannot constrain that credential to a branch. Site devices are explicit,
-- location-scoped identities. Their bearer credential is hash-only and each
-- location may pair independently. Existing business tokens remain readable
-- during migration; newly paired desktops use site_sync_credentials.

CREATE TABLE site_devices (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id    uuid NOT NULL,
    public_id      uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    display_name   text NOT NULL CHECK (char_length(trim(display_name)) BETWEEN 1 AND 120),
    status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'revoked')),
    created_at     timestamptz NOT NULL DEFAULT now(),
    last_seen_at   timestamptz,
    revoked_at     timestamptz,
    CONSTRAINT site_devices_id_business_unique UNIQUE (id, business_id),
    CONSTRAINT site_devices_location_business_fk
      FOREIGN KEY (location_id, business_id) REFERENCES locations(id, business_id) ON DELETE CASCADE
);

CREATE INDEX idx_site_devices_business_location
  ON site_devices (business_id, location_id, created_at DESC);
CREATE INDEX idx_site_devices_active
  ON site_devices (business_id, location_id) WHERE status = 'active' AND revoked_at IS NULL;

CREATE TABLE site_sync_credentials (
    site_device_id uuid PRIMARY KEY REFERENCES site_devices(id) ON DELETE CASCADE,
    business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    token_hash     text NOT NULL UNIQUE CHECK (char_length(token_hash) = 64),
    created_at     timestamptz NOT NULL DEFAULT now(),
    rotated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT site_sync_credentials_device_business_fk
      FOREIGN KEY (site_device_id, business_id)
      REFERENCES site_devices(id, business_id) ON DELETE CASCADE
);
CREATE INDEX idx_site_sync_credentials_business ON site_sync_credentials (business_id);

ALTER TABLE site_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_devices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON site_devices FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE site_sync_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_sync_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON site_sync_credentials FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- A pairing code now claims one location. Several locations of one business
-- may have one live code each, while re-issuing for the same location revokes
-- that location's previous code.
DROP INDEX IF EXISTS idx_pairing_codes_live_business;
CREATE UNIQUE INDEX idx_pairing_codes_live_location
  ON install_pairing_codes (business_id, location_id)
  WHERE redeemed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX idx_pairing_codes_location ON install_pairing_codes (location_id, created_at DESC);

ALTER TABLE sync_events
  ADD COLUMN site_device_id uuid REFERENCES site_devices(id) ON DELETE SET NULL,
  ADD COLUMN schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0);
CREATE INDEX idx_sync_events_site_device ON sync_events (site_device_id, id) WHERE site_device_id IS NOT NULL;
