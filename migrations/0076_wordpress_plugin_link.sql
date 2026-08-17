-- ============================================================================
-- 0076_wordpress_plugin_link.sql — a second way to connect a WooCommerce store
--
-- Migration 0070 connects a store the only way WooCommerce itself offers out
-- of the box: the owner generates REST consumer keys in WP admin, pastes them
-- here, and separately configures webhooks pointing back at us. That works,
-- but it is four manual steps in two systems, each of which fails silently
-- when a step is skipped — and it puts the store's *master* credentials into
-- this database, where they authorise far more than this integration needs.
--
-- The plugin link is the other direction: a WordPress plugin holds one token
-- scoped to this integration alone, signs every request with it, pushes the
-- events it sees, and pulls the work it should apply. Nothing about the store
-- is stored here but that one token, and the owner's whole setup is
-- "paste an address and a token, press test".
--
-- Both modes stay first-class — `link_mode` says which one a connection is —
-- because a store that cannot install plugins still needs the REST path.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- The connection grows a mode, and the credentials each mode needs
-- ---------------------------------------------------------------------------
ALTER TABLE integration_connections
    ADD COLUMN link_mode text NOT NULL DEFAULT 'rest_api'
        CHECK (link_mode IN ('rest_api', 'plugin')),
    -- SHA-256 of the link token: the *lookup* key. UNIQUE because the token is
    -- also the identifier — an inbound plugin request resolves its connection
    -- by this hash before any tenant is chosen.
    ADD COLUMN link_token_hash text UNIQUE,
    -- …and the token itself under AES-256-GCM, for the same reason
    -- webhook_secret_ciphertext is stored rather than hashed: the token is the
    -- HMAC key every inbound request is verified against, and a hash cannot
    -- verify an HMAC. Encrypted at rest through secrets.ts, so a database read
    -- alone still yields nothing usable without INTEGRATIONS_ENCRYPTION_KEY.
    ADD COLUMN link_token_ciphertext text,
    ADD COLUMN link_token_set_at timestamptz,
    -- What the plugin last told us about itself, for the management screen.
    ADD COLUMN plugin_version text,
    ADD COLUMN plugin_site_url text,
    ADD COLUMN last_plugin_seen_at timestamptz;

-- REST consumer keys are meaningless in plugin mode, so they stop being
-- mandatory — but only there. The CHECK keeps a rest_api connection unable to
-- exist without them, which is what the client code has always assumed.
ALTER TABLE integration_connections
    ALTER COLUMN consumer_key_ciphertext DROP NOT NULL,
    ALTER COLUMN consumer_secret_ciphertext DROP NOT NULL;

ALTER TABLE integration_connections
    ADD CONSTRAINT integration_connections_mode_credentials CHECK (
        link_mode = 'plugin'
        OR (consumer_key_ciphertext IS NOT NULL AND consumer_secret_ciphertext IS NOT NULL)
    );

ALTER TABLE integration_connections
    ADD CONSTRAINT integration_connections_plugin_token CHECK (
        link_mode <> 'plugin'
        OR (link_token_hash IS NOT NULL AND link_token_ciphertext IS NOT NULL)
    );

-- ---------------------------------------------------------------------------
-- The outbox becomes the plugin's job queue as well as the REST push queue
--
-- In rest_api mode the app drains these itself by calling the store. In plugin
-- mode the plugin drains them by pulling — same rows, same retry/dead-letter
-- state, opposite direction of travel — so there is one queue to monitor
-- rather than two. That needs two job kinds the REST path never had:
-- `catalogue_export` and `customer_export` ask the plugin to send what only it
-- can see.
-- ---------------------------------------------------------------------------
ALTER TABLE integration_outbox_events
    DROP CONSTRAINT IF EXISTS integration_outbox_events_entity_type_check;
ALTER TABLE integration_outbox_events
    ADD CONSTRAINT integration_outbox_events_entity_type_check
        CHECK (entity_type IN ('stock', 'price', 'catalogue_export', 'customer_export'));

-- Which connection a plugin has leased jobs to, so a slow plugin re-pulling
-- doesn't hand the same job to two concurrent WP-Cron runs.
ALTER TABLE integration_outbox_events
    ADD COLUMN leased_until timestamptz;
CREATE INDEX idx_integration_outbox_lease
    ON integration_outbox_events (connection_id, leased_until)
    WHERE status = 'processing';

-- ---------------------------------------------------------------------------
-- Replay protection for the signed plugin channel
--
-- The signature covers a timestamp and a nonce, so a captured request is
-- valid only inside the freshness window and only once. The window bounds how
-- long a row must be kept; `seen_at` is what the sweep in plugin-service.ts
-- deletes by.
-- ---------------------------------------------------------------------------
CREATE TABLE integration_plugin_nonces (
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    connection_id uuid NOT NULL,
    nonce         text NOT NULL CHECK (char_length(nonce) BETWEEN 8 AND 128),
    seen_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (connection_id, nonce),
    CONSTRAINT integration_plugin_nonces_connection_business_fk
        FOREIGN KEY (connection_id, business_id)
        REFERENCES integration_connections (id, business_id)
        ON DELETE CASCADE
);
CREATE INDEX idx_integration_plugin_nonces_seen ON integration_plugin_nonces (seen_at);

-- Phase 12 rule: a new tenant-scoped table needs its policy in the same
-- migration that creates it (see CLAUDE.md).
ALTER TABLE integration_plugin_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_plugin_nonces FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integration_plugin_nonces FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
