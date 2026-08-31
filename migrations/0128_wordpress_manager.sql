-- ============================================================================
-- 0128_wordpress_manager.sql — Phase 40
-- The fifth app: full WordPress / WooCommerce management.
--
-- This migration is the storage half of three things:
--
--   1. The plugin link learns to *report* WordPress content (posts, pages,
--      media) the same way it reports commerce events: as signed,
--      idempotent events over the channel that already exists. Those rows
--      are mirrored here so the WP Manager can browse and operate on the
--      site without the app ever dialing it.
--
--   2. The outbox gains the content-operation job kinds (create/update a
--      post or page, upload media) the plugin applies on its next pull,
--      alongside the stock/price/order jobs it already handles. The app
--      holds no REST credentials in plugin mode, so every write goes
--      through this queue in both link modes.
--
--   3. The connection gains timestamps for the two sweeps the plugin runs
--      on its own (customers had no sweep at all — see the plugin's
--      export_customers), so the manager screen can show which part of
--      the mirror is stale instead of one blended «آخرین همگام‌سازی».
--
-- Every table is tenant-scoped with the standard policy; the generated
-- coverage assertion in integration/tenant-isolation proves it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- WordPress content mirrored from a connected site
--
-- One row per remote object. `wp_type` keeps posts ('post'), static pages
-- ('page'), custom post types a theme/plugin registered ('product' is NOT
-- here — products live in the WooCommerce tables) and media attachments
-- ('attachment') in one mirror, keyed like every other integration object on
-- the remote id. Media rows carry the attachment URL in payload rather than a
-- column: bytes never pass through this app.
-- ---------------------------------------------------------------------------
CREATE TABLE integration_wp_content (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    connection_id uuid NOT NULL,
    -- 'post' | 'page' | 'attachment' | a custom post type slug. Text, not an
    -- enum: the set is decided by the WordPress site, not by us.
    wp_type       text NOT NULL CHECK (char_length(wp_type) BETWEEN 1 AND 100),
    remote_id     text NOT NULL,
    title         text NOT NULL DEFAULT '',
    slug          text NOT NULL DEFAULT '',
    status        text NOT NULL DEFAULT '',
    -- 'publish' | 'draft' | … kept as the site's own word, for the badge.
    permalink     text NOT NULL DEFAULT '',
    -- The author's display name as the site reports it; no local user link.
    author_name   text NOT NULL DEFAULT '',
    -- Attachments: the source URL and mime type. Null for posts/pages.
    media_url     text,
    mime_type     text,
    -- The raw REST-shaped object, kept whole for the same reason
    -- integration_woo_terms.payload is: a field this app has not modelled
    -- must not be thrown away on the way through.
    payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
    remote_updated_at timestamptz,
    synced_at     timestamptz NOT NULL DEFAULT now(),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (connection_id, wp_type, remote_id),
    CONSTRAINT integration_wp_content_connection_business_fk
        FOREIGN KEY (connection_id, business_id)
        REFERENCES integration_connections (id, business_id)
        ON DELETE CASCADE
);
CREATE INDEX idx_integration_wp_content_connection
    ON integration_wp_content (connection_id, wp_type, status);

-- ---------------------------------------------------------------------------
-- Outbox: the content-operation job kinds, plus the content export request.
--
-- 'content_export' asks the plugin to re-send every post/page/media row (the
-- WP Manager's «همگام‌سازی محتوا» button in plugin mode). The *_upsert jobs
-- carry a REST-shaped body the plugin applies field-by-field, the same closed
-- list discipline product_update uses — the payload is filtered on the app
-- side before it is ever queued.
-- ---------------------------------------------------------------------------
ALTER TABLE integration_outbox_events
    DROP CONSTRAINT IF EXISTS integration_outbox_events_entity_type_check;
ALTER TABLE integration_outbox_events
    ADD CONSTRAINT integration_outbox_events_entity_type_check
        CHECK (entity_type IN (
            'stock', 'price', 'catalogue_export', 'customer_export',
            'holoo_sale', 'holoo_receipt', 'holoo_purchase',
            'product_update',
            'order_status',
            'refund_create',
            'orders_export',
            -- Phase 40 — WordPress content, operated through the same queue.
            'content_export',
            'post_upsert',
            'media_create'
        ));

-- ---------------------------------------------------------------------------
-- Per-direction sync watermarks. `last_sync_at` stays the blended «it talked
-- to us recently» stamp; these answer the specific «is the customer book /
-- content mirror stale?» questions the WP Manager screen asks.
-- ---------------------------------------------------------------------------
ALTER TABLE integration_connections
    ADD COLUMN IF NOT EXISTS last_customer_sync_at timestamptz,
    ADD COLUMN IF NOT EXISTS last_content_sync_at timestamptz;

-- ---------------------------------------------------------------------------
-- RLS — the standard template
-- ---------------------------------------------------------------------------
ALTER TABLE integration_wp_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_wp_content FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integration_wp_content FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
