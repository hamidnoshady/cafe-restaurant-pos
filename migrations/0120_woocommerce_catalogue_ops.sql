-- ============================================================================
-- 0120_woocommerce_catalogue_ops.sql — Phase 38
-- WooCommerce, taken seriously as a catalogue rather than as a list of SKUs.
--
-- What Phase 23 shipped was correct for the store it was written against: a
-- café with twenty simple products, where "a product" and "a thing you can
-- sell" were the same row. WooCommerce has never worked that way. A product
-- there is one of eight-ish *types*, and for `variable` products the thing
-- you can sell is not the product at all — it is one of its variations, which
-- has its own SKU, its own price, its own stock, and its own row in the
-- order's line items. Three consequences shipped as bugs:
--
--   1. `/wp-json/wc/v3/products` does not return variations. They live at
--      `products/{parent}/variations`, which nothing ever called, so a REST
--      connection never had a variation to map — every variation line in
--      every order resolved to nothing.
--   2. An order line carries both `product_id` and `variation_id`. The app
--      read only `product_id`, so a variation line resolved to its *parent*
--      — which the sync writes as `kind='variant_parent'`, explicitly not
--      sellable, with no stock row. Revenue was recorded; stock and COGS
--      silently were not.
--   3. The two doors disagreed. A WooCommerce webhook sends product_id =
--      parent + variation_id = child. The WordPress plugin sent product_id =
--      the variation (because `WC_Order_Item_Product::get_product()` returns
--      the variation when there is one) and no variation_id at all. The same
--      order, in the same app, resolved to two different items depending on
--      how the store was connected.
--
-- This migration is the storage half of fixing all three, plus the storage
-- half of two things the integration never had: the store's own taxonomy
-- tree (categories, tags, attribute terms, and whatever custom taxonomies a
-- shop's theme or plugins registered), and outbound *operations* — the app
-- telling the store to do something, not just nudging a number.
--
-- Every table is tenant-scoped with the standard policy; the generated
-- coverage assertion in integration/tenant-isolation proves it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- The connection learns what it is allowed to pull, and when it last did
-- ---------------------------------------------------------------------------
ALTER TABLE integration_connections
    -- WooCommerce's product_cat is the store's own navigation. Copying it
    -- into the POS rearranges a menu or an item list the owner may have
    -- curated by hand, so it is opt-in and off for every existing
    -- connection: turning it on is a decision, never a side effect of
    -- upgrading.
    ADD COLUMN sync_categories boolean NOT NULL DEFAULT false,
    -- REST mode: webhooks are the fast path but they are also the one thing
    -- an owner can forget to configure, and a missed webhook is a sale that
    -- never appears. A scheduled pull covers the gap by re-reading recent
    -- orders the same way the catalogue is read.
    ADD COLUMN auto_pull_orders boolean NOT NULL DEFAULT true,
    -- How far back that pull looks. Seven days is one business week: long
    -- enough to survive a weekend of downtime, short enough that a first
    -- connection does not re-read four years of history.
    ADD COLUMN order_lookback_days integer NOT NULL DEFAULT 7
        CHECK (order_lookback_days BETWEEN 1 AND 365),
    -- Split from `last_sync_at` because the two jobs have different cadences
    -- and different failure modes. "Products synced 3 minutes ago, orders
    -- not for six hours" is a diagnosis; a single timestamp hides it.
    ADD COLUMN last_catalogue_sync_at timestamptz,
    ADD COLUMN last_order_sync_at timestamptz;

-- ---------------------------------------------------------------------------
-- The store's taxonomy tree
--
-- One row per remote term, of any taxonomy. Not only `product_cat`: the
-- attribute terms that make a variation distinguishable (`pa_color` /
-- `pa_size`) are the same shape and the same question, and a shop running a
-- custom taxonomy (a brand, a fabric, a region — anything a theme or a
-- plugin registered) has data there that this app could never see before.
--
-- Deliberately NOT a local category model. F&B has `menu_categories` and
-- retail has none, and inventing one for `items` to hold a WooCommerce
-- mirror would change what the retail modules show for every business,
-- connected or not. This is a mirror of a remote system, keyed by remote
-- ids, and it is only ever read *about* the store; `sync_categories` above
-- is the separate, explicit bridge into the local menu when an owner wants
-- one.
-- ---------------------------------------------------------------------------
CREATE TABLE integration_woo_terms (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    connection_id uuid NOT NULL,
    -- 'product_cat', 'product_tag', 'pa_color', 'brand', … — whatever the
    -- store registered. Text, not an enum: the set is decided by the store,
    -- not by us, and a CHECK here would make a custom taxonomy unsyncable.
    taxonomy      text NOT NULL CHECK (char_length(taxonomy) BETWEEN 1 AND 190),
    remote_id     text NOT NULL,
    parent_remote_id text,
    name          text NOT NULL DEFAULT '',
    slug          text NOT NULL DEFAULT '',
    description   text NOT NULL DEFAULT '',
    -- How many products the store says carry this term. Shown next to the
    -- name; it is the store's own count, so it is authoritative about the
    -- store even when this connection has not mapped all of them.
    remote_count  integer NOT NULL DEFAULT 0 CHECK (remote_count >= 0),
    menu_order    integer NOT NULL DEFAULT 0,
    -- The raw term as WooCommerce returned it. Kept whole because a
    -- taxonomy we have never heard of may carry fields we do not model, and
    -- throwing them away is the reason a mirror like this one gets accused
    -- of losing data.
    payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
    synced_at     timestamptz NOT NULL DEFAULT now(),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (connection_id, taxonomy, remote_id),
    CONSTRAINT integration_woo_terms_connection_business_fk
        FOREIGN KEY (connection_id, business_id)
        REFERENCES integration_connections (id, business_id)
        ON DELETE CASCADE
);
CREATE INDEX idx_integration_woo_terms_connection
    ON integration_woo_terms (connection_id, taxonomy, remote_id);
CREATE INDEX idx_integration_woo_terms_parent
    ON integration_woo_terms (connection_id, taxonomy, parent_remote_id)
    WHERE parent_remote_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Which remote product carries which remote term
--
-- Keyed on remote ids on both sides, so it is industry-agnostic: it says
-- "product 41 is in category 9" whether that product became a `menu_items`
-- row or an `items` row, and it survives a product being re-mapped or
-- re-synced under a different local id. A local FK here would have to be two
-- FKs (one per industry's table) with a CHECK that exactly one is set —
-- which is a worse shape for a fact that is really about the *store*.
-- ---------------------------------------------------------------------------
CREATE TABLE integration_woo_product_terms (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    connection_id uuid NOT NULL,
    -- The remote product or variation id.
    remote_id     text NOT NULL,
    taxonomy      text NOT NULL CHECK (char_length(taxonomy) BETWEEN 1 AND 190),
    term_remote_id text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (connection_id, remote_id, taxonomy, term_remote_id),
    CONSTRAINT integration_woo_product_terms_connection_business_fk
        FOREIGN KEY (connection_id, business_id)
        REFERENCES integration_connections (id, business_id)
        ON DELETE CASCADE
);
CREATE INDEX idx_integration_woo_product_terms_product
    ON integration_woo_product_terms (connection_id, remote_id);
-- The reverse lookup: "every product in category 9".
CREATE INDEX idx_integration_woo_product_terms_term
    ON integration_woo_product_terms (connection_id, taxonomy, term_remote_id);

-- ---------------------------------------------------------------------------
-- The outbox stops being a stock/price channel and becomes an operations one
--
-- Three new kinds, and the reason each is a queue row rather than a direct
-- call: all three must work in plugin mode, where the app cannot reach the
-- store at all and the plugin is the only thing that can apply them. Putting
-- them through the outbox is what makes "change that order's status" behave
-- identically whether the store is reachable or behind a firewall.
-- ---------------------------------------------------------------------------
ALTER TABLE integration_outbox_events
    DROP CONSTRAINT IF EXISTS integration_outbox_events_entity_type_check;
ALTER TABLE integration_outbox_events
    ADD CONSTRAINT integration_outbox_events_entity_type_check
        CHECK (entity_type IN (
            'stock', 'price', 'catalogue_export', 'customer_export',
            'holoo_sale', 'holoo_receipt', 'holoo_purchase',
            -- An arbitrary field patch on a product or one of its variations
            -- (name, regular_price, status, description, stock). Supersedes
            -- `stock`/`price` for anything triggered from the dashboard;
            -- those two stay because the automatic diff still uses them.
            'product_update',
            -- WooCommerce order status transitions (processing/completed/
            -- cancelled …), pushed from the app's own sales screens.
            'order_status',
            -- A refund created in the app and applied to the store.
            'refund_create',
            -- Ask the plugin to (re)send orders changed since a watermark.
            -- The REST path answers this itself and never enqueues it.
            'orders_export'
        ));

-- ---------------------------------------------------------------------------
-- A mapping kind for the category bridge
--
-- When `sync_categories` is on, a WooCommerce `product_cat` term becomes a
-- `menu_categories` row. That pairing needs to be remembered, or every sync
-- would create a new menu category beside the one it created last time.
-- ---------------------------------------------------------------------------
ALTER TABLE integration_mappings
    DROP CONSTRAINT IF EXISTS integration_mappings_entity_type_check;
ALTER TABLE integration_mappings
    ADD CONSTRAINT integration_mappings_entity_type_check
        CHECK (entity_type IN (
            'product', 'customer', 'order', 'refund', 'category',
            'holoo_goods', 'holoo_customer', 'holoo_account', 'holoo_invoice',
            'holoo_purchase', 'holoo_receipt', 'holoo_stock', 'holoo_journal',
            'holoo_document'
        ));

-- ---------------------------------------------------------------------------
-- RLS — the standard template
-- ---------------------------------------------------------------------------
ALTER TABLE integration_woo_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_woo_terms FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integration_woo_terms FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE integration_woo_product_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_woo_product_terms FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integration_woo_product_terms FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
