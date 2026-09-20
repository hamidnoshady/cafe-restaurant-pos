-- ============================================================================
-- 0156_wp_woo_connector_repair.sql
-- WordPress/WooCommerce connector reliability repairs.
--
-- Adds explicit paused/deferred inbox semantics, plugin telemetry/capability
-- storage, separate WordPress Core REST credentials, and operation ids for
-- non-idempotent outbound jobs. All additions are forward-only and preserve
-- existing connection rows, mappings, outbox rows and plugin queues.
-- ============================================================================

-- Plugin runtime state reported by the authenticated WordPress plugin. This is
-- safe operational telemetry only: queue counts, cron timestamps, capabilities,
-- version/site diagnostics. Secrets stay in their existing encrypted columns.
ALTER TABLE integration_connections
    ADD COLUMN IF NOT EXISTS plugin_health jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS plugin_capabilities jsonb,
    ADD COLUMN IF NOT EXISTS pending_plugin_site_url text,
    ADD COLUMN IF NOT EXISTS plugin_site_mismatch_at timestamptz,
    -- WordPress Core REST credentials are deliberately separate from
    -- WooCommerce consumer credentials. Woo keys authorize wc/v3 commerce calls;
    -- they must not be silently reused for wp/v2 posts/pages/media.
    ADD COLUMN IF NOT EXISTS wp_username_ciphertext text,
    ADD COLUMN IF NOT EXISTS wp_application_password_ciphertext text;

-- Inbound events received while a connection is paused are authenticated and
-- stored, but not applied. They are replayed from the same inbox row after
-- resume, preserving idempotency and avoiding Woo/plugin retry storms.
ALTER TABLE integration_webhook_events
    DROP CONSTRAINT IF EXISTS integration_webhook_events_status_check;
ALTER TABLE integration_webhook_events
    ADD CONSTRAINT integration_webhook_events_status_check
        CHECK (status IN ('pending', 'deferred', 'processed', 'failed', 'duplicate'));
CREATE INDEX IF NOT EXISTS idx_integration_webhook_events_deferred
    ON integration_webhook_events (connection_id, created_at)
    WHERE status = 'deferred';

-- Non-idempotent outbound operations (refund/post/media create) need a stable
-- operation id and an operator-review state for ambiguous outcomes.
ALTER TABLE integration_outbox_events
    ADD COLUMN IF NOT EXISTS operation_id text;
ALTER TABLE integration_outbox_events
    DROP CONSTRAINT IF EXISTS integration_outbox_events_status_check;
ALTER TABLE integration_outbox_events
    ADD CONSTRAINT integration_outbox_events_status_check
        CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'dead', 'needs_review'));
CREATE UNIQUE INDEX IF NOT EXISTS idx_integration_outbox_operation_id
    ON integration_outbox_events (connection_id, operation_id)
    WHERE operation_id IS NOT NULL;
