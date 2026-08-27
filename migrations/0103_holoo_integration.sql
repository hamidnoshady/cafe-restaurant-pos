-- ============================================================================
-- 0103_holoo_integration.sql — Phase 26 / issue #125 (Wave 2)
-- Holoo (هلو) as a second provider on the Phase 23 integration gateway.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. provider: a second value, and credentials that are WooCommerce-only
-- ---------------------------------------------------------------------------
ALTER TABLE integration_connections
    DROP CONSTRAINT IF EXISTS integration_connections_provider_check;
ALTER TABLE integration_connections
    ADD CONSTRAINT integration_connections_provider_check
        CHECK (provider IN ('woocommerce', 'holoo'));

ALTER TABLE integration_connections
    ALTER COLUMN base_url DROP NOT NULL,
    ALTER COLUMN consumer_key_ciphertext DROP NOT NULL,
    ALTER COLUMN consumer_secret_ciphertext DROP NOT NULL,
    ALTER COLUMN webhook_secret_ciphertext DROP NOT NULL;

-- The mode/credentials CHECK from 0076 says a rest_api connection must have
-- consumer keys. A Holoo connection is neither rest_api nor plugin — it has
-- its own credential shape on holoo_connection_settings — so provider = 'holoo'
-- is an additional escape. WooCommerce semantics are unchanged.
ALTER TABLE integration_connections
    DROP CONSTRAINT IF EXISTS integration_connections_mode_credentials;
ALTER TABLE integration_connections
    ADD CONSTRAINT integration_connections_mode_credentials CHECK (
        provider = 'holoo'
        OR link_mode = 'plugin'
        OR (consumer_key_ciphertext IS NOT NULL AND consumer_secret_ciphertext IS NOT NULL)
    );

-- Legacy WooCommerce rows may have missing credentials: the original schema
-- allowed an empty encrypted value, and the plugin migration made the consumer
-- key columns nullable. Preserve those rows while keeping the provider shape
-- explicit. New REST connections are validated by the application before
-- insertion; plugin connections use their dedicated token columns.
ALTER TABLE integration_connections
    ADD CONSTRAINT integration_connections_provider_credentials CHECK (
        provider <> 'woocommerce'
        OR link_mode = 'plugin'
        OR (
            base_url IS NOT NULL
            AND webhook_secret_ciphertext IS NOT NULL
        )
    );

-- ---------------------------------------------------------------------------
-- 2. holoo_connection_settings — the Holoo-specific facts for one connection
-- ---------------------------------------------------------------------------
CREATE TABLE holoo_connection_settings (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    connection_id uuid NOT NULL,
    host          text NOT NULL CHECK (char_length(trim(host)) BETWEEN 1 AND 255),
    port          integer NOT NULL DEFAULT 1433 CHECK (port BETWEEN 1 AND 65535),
    database      text NOT NULL CHECK (char_length(trim(database)) BETWEEN 1 AND 255),
    sql_user_ciphertext     text,
    sql_password_ciphertext text,
    web_service_base_url    text,
    ws_user_ciphertext      text,
    ws_password_ciphertext  text,
    holoo_version   text,
    schema_profile  text,
    currency_unit   text NOT NULL DEFAULT 'rial' CHECK (currency_unit IN ('rial', 'toman')),
    write_mode      text NOT NULL DEFAULT 'none' CHECK (write_mode IN ('none', 'web_service', 'direct_sql')),
    direct_sql_armed_at timestamptz,
    direct_sql_armed_by uuid REFERENCES users(id) ON DELETE SET NULL,
    companion_activated_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (connection_id),
    UNIQUE (id, business_id),
    CONSTRAINT holoo_connection_settings_connection_business_fk
        FOREIGN KEY (connection_id, business_id)
        REFERENCES integration_connections (id, business_id)
        ON DELETE CASCADE
);
CREATE INDEX idx_holoo_connection_settings_business
    ON holoo_connection_settings (business_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 3. holoo_sync_cursors — the polling high-water mark per (connection, entity)
-- ---------------------------------------------------------------------------
CREATE TABLE holoo_sync_cursors (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    connection_id uuid NOT NULL,
    entity_type   text NOT NULL CHECK (char_length(entity_type) BETWEEN 1 AND 80),
    last_key      text,
    last_seen_at  timestamptz,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (connection_id, entity_type),
    UNIQUE (id, business_id),
    CONSTRAINT holoo_sync_cursors_connection_business_fk
        FOREIGN KEY (connection_id, business_id)
        REFERENCES integration_connections (id, business_id)
        ON DELETE CASCADE
);
CREATE INDEX idx_holoo_sync_cursors_business
    ON holoo_sync_cursors (business_id);

-- ---------------------------------------------------------------------------
-- 4. RLS — the standard template, one policy per table
-- ---------------------------------------------------------------------------
ALTER TABLE holoo_connection_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE holoo_connection_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON holoo_connection_settings FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE holoo_sync_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE holoo_sync_cursors FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON holoo_sync_cursors FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
