-- ============================================================================
-- 0136_website_manager.sql — Phase 38 (issues #378–#382): the website manager
-- behind a `WebsiteAdapter`, and one-way product/stock/price sync to the site.
--
-- Three things, in one forward-only step:
--
--   1. eshobe_cms_connections grows the columns the adapter pattern needs. The
--      issue drafted a fresh `website_connections`; by the time it was built
--      migration 0122 already held the encrypted credential for the one
--      adapter that exists (Payload / eshobe-cms), so the row is *extended*
--      rather than duplicated — one connection, one credential store:
--        adapter_key      which WebsiteAdapter implementation this row is for
--        site_currency    the site's minor unit, so Rial↔site conversion is a
--                         pure function of the row and never a live call
--        last_checked_at / last_error   the connection test, recorded
--        push_prices / push_stock       two INDEPENDENT switches (Wave 3)
--        product_scope    'selected' (only marked rows go) or 'all'
--        sync_location_id which branch's stock/prices the site shows
--
--   2. website_product_map — which local product (an F&B `menu_item` or a retail
--      `item`; the two models never merge, by Phase 21's decision) is mirrored
--      as which remote product, whether the owner marked it to go at all, and
--      what was last pushed (so the tick can diff instead of re-sending).
--
--   3. website_outbox — the queue. The SAME shape as integration_outbox_events
--      (0070): status/attempts/next_attempt_at/backoff/dead-letter, one row per
--      (kind, local product) that is re-armed on conflict rather than
--      duplicated. That UNIQUE is the coalescing rule: a hundred sales in an
--      hour re-arm one `stock.set` row, and the quantity sent is read from the
--      database at drain time, never from the payload.
--
-- Plus the autopilot category CHECKs widen to admit 'website' (Wave 4): the
-- draft/update/upsert actions live under it; publishing is deliberately in no
-- category at all (see ACTION_CATALOG's `alwaysConfirm`).
--
-- Tenant RLS on both new tables, in this migration, per CLAUDE.md.
-- ============================================================================

ALTER TABLE eshobe_cms_connections
    ADD COLUMN adapter_key      text NOT NULL DEFAULT 'payload'
                                CHECK (adapter_key IN ('payload', 'mock')),
    ADD COLUMN site_currency    text NOT NULL DEFAULT 'IRT'
                                CHECK (site_currency IN ('IRT', 'IRR', 'EUR', 'USD')),
    ADD COLUMN last_checked_at  timestamptz,
    ADD COLUMN last_error       text,
    ADD COLUMN push_prices      boolean NOT NULL DEFAULT false,
    ADD COLUMN push_stock       boolean NOT NULL DEFAULT false,
    ADD COLUMN product_scope    text NOT NULL DEFAULT 'selected'
                                CHECK (product_scope IN ('selected', 'all')),
    ADD COLUMN sync_location_id uuid REFERENCES locations(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- website_product_map
-- ---------------------------------------------------------------------------
CREATE TABLE website_product_map (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id            uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    local_kind             text NOT NULL CHECK (local_kind IN ('item', 'menu_item')),
    local_id               uuid NOT NULL,
    -- NULL until the first successful product.upsert names the remote row.
    remote_id              text,
    -- The owner's mark. Default false: an unasked-for sync of a whole
    -- warehouse onto a public site is not something you can take back.
    sync_enabled           boolean NOT NULL DEFAULT false,
    last_pushed_at         timestamptz,
    last_pushed_price_rial bigint CHECK (last_pushed_price_rial IS NULL OR last_pushed_price_rial >= 0),
    last_pushed_stock      numeric(24, 9),
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, local_kind, local_id)
);
CREATE INDEX idx_website_product_map_enabled
    ON website_product_map (business_id) WHERE sync_enabled;

ALTER TABLE website_product_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE website_product_map FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON website_product_map FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- website_outbox
-- ---------------------------------------------------------------------------
CREATE TABLE website_outbox (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    kind            text NOT NULL CHECK (kind IN ('product.upsert', 'stock.set', 'price.set')),
    local_kind      text NOT NULL CHECK (local_kind IN ('item', 'menu_item')),
    local_id        uuid NOT NULL,
    -- Routing parameters only ("which product"); never the number. The
    -- quantity/price is read from the database at the moment of sending.
    payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
    status          text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'dead')),
    attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    error           text,
    sent_at         timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    -- The coalescing rule (see header).
    UNIQUE (business_id, kind, local_kind, local_id)
);
CREATE INDEX idx_website_outbox_due
    ON website_outbox (business_id, next_attempt_at)
    WHERE status IN ('pending', 'failed');

ALTER TABLE website_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE website_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON website_outbox FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- Autopilot: a sixth category, 'website', for the assistant's drafting
-- actions. The numeric ceilings are unchanged; only the category list widens.
-- ---------------------------------------------------------------------------
ALTER TABLE ai_autopilot_settings
    DROP CONSTRAINT ai_autopilot_settings_category_check,
    ADD CONSTRAINT ai_autopilot_settings_category_check
        CHECK (category IN ('inventory', 'pricing', 'money', 'customer', 'waste', 'website'));

ALTER TABLE ai_action_audit
    DROP CONSTRAINT ai_action_audit_autopilot_category_check,
    ADD CONSTRAINT ai_action_audit_autopilot_category_check
        CHECK (autopilot_category IS NULL OR autopilot_category IN
               ('inventory', 'pricing', 'money', 'customer', 'waste', 'website'));
