-- ============================================================================
-- 0070_woocommerce_integration.sql — Phase 23 / issue #118
-- WooCommerce two-way integration: connection auth, order/refund inbox,
-- product/customer mapping, stock/price outbox, reconciliation, audit log.
--
-- Every table is tenant-scoped through the standard tenant_isolation policy
-- (app_rls_bypass() OR business_id = app_current_business()), so the generated
-- RLS isolation test in integration/tenant-isolation.integration.test.ts proves
-- this boundary exactly like every other tenant table.
--
-- Secrets (consumer key/secret, webhook secret) are stored as AES-256-GCM
-- ciphertext produced by src/lib/integrations/secrets.ts — never plaintext.
-- Money is integer Rial; a connection's currency_unit ('rial'|'toman') is how
-- WooCommerce decimal amounts are converted (src/lib/integrations/woo-money.ts).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Wave 1 — a WooCommerce store connected to one business (optionally one branch)
-- ---------------------------------------------------------------------------
CREATE TABLE integration_connections (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id uuid REFERENCES locations(id) ON DELETE CASCADE,
    name        text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 120),
    provider    text NOT NULL DEFAULT 'woocommerce' CHECK (provider = 'woocommerce'),
    base_url    text NOT NULL CHECK (base_url ~* '^https?://[^[:space:]]+$'),
    consumer_key_ciphertext      text NOT NULL,
    consumer_secret_ciphertext   text NOT NULL,
    webhook_secret_ciphertext    text NOT NULL,
    currency_unit text NOT NULL DEFAULT 'toman' CHECK (currency_unit IN ('rial', 'toman')),
    sync_orders    boolean NOT NULL DEFAULT true,
    sync_products  boolean NOT NULL DEFAULT true,
    sync_customers boolean NOT NULL DEFAULT true,
    push_stock     boolean NOT NULL DEFAULT true,
    push_prices    boolean NOT NULL DEFAULT true,
    status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'error')),
    last_sync_at timestamptz,
    last_error   text,
    created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    -- The composite id+business unique index is what lets child tables prove
    -- (with a composite FK) that they never attach a row to another
    -- business's connection, the same pattern api_keys uses.
    UNIQUE (id, business_id)
);
CREATE INDEX idx_integration_connections_business
    ON integration_connections (business_id, created_at DESC);
CREATE INDEX idx_integration_connections_location
    ON integration_connections (location_id) WHERE location_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Wave 2 — inbox: inbound WooCommerce webhook deliveries, idempotent
-- ---------------------------------------------------------------------------
CREATE TABLE integration_webhook_events (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    connection_id uuid NOT NULL,
    event_topic   text NOT NULL CHECK (char_length(event_topic) BETWEEN 1 AND 120),
    -- WooCommerce resource id (order id, product id, …), text because Woo's
    -- ids are plain integers and may exceed a pg integer's range.
    remote_id     text NOT NULL,
    -- X-WC-Webhook-Delivery-Id — the idempotency key WooCommerce guarantees
    -- is unique per delivery.
    delivery_id   text NOT NULL,
    payload       jsonb NOT NULL,
    status        text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'processed', 'failed', 'duplicate')),
    error         text,
    processed_at  timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (connection_id, delivery_id),
    CONSTRAINT integration_webhook_events_connection_business_fk
        FOREIGN KEY (connection_id, business_id)
        REFERENCES integration_connections (id, business_id)
        ON DELETE CASCADE
);
CREATE INDEX idx_integration_webhook_events_connection
    ON integration_webhook_events (connection_id, created_at DESC);
CREATE INDEX idx_integration_webhook_events_status
    ON integration_webhook_events (status) WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Wave 3 — remote id ↔ local id mapping per entity type
-- ---------------------------------------------------------------------------
CREATE TABLE integration_mappings (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    connection_id uuid NOT NULL,
    entity_type   text NOT NULL CHECK (entity_type IN ('product', 'customer', 'order', 'refund')),
    remote_id     text NOT NULL,
    local_id      uuid NOT NULL,
    -- For stock/price push: the value last successfully pushed to WooCommerce,
    -- so the outbox tick can diff against it without a round trip.
    last_pushed_payload jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (connection_id, entity_type, remote_id),
    CONSTRAINT integration_mappings_connection_business_fk
        FOREIGN KEY (connection_id, business_id)
        REFERENCES integration_connections (id, business_id)
        ON DELETE CASCADE
);
CREATE INDEX idx_integration_mappings_local
    ON integration_mappings (entity_type, local_id);

-- ---------------------------------------------------------------------------
-- Wave 4 — outbox: stock/price pushes to WooCommerce, retried by a background
-- tick with backoff and dead-lettering
-- ---------------------------------------------------------------------------
CREATE TABLE integration_outbox_events (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    connection_id uuid NOT NULL,
    entity_type   text NOT NULL CHECK (entity_type IN ('stock', 'price')),
    remote_id     text NOT NULL,
    local_id      uuid,
    payload       jsonb NOT NULL,
    status        text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'dead')),
    attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    last_error    text,
    sent_at       timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (connection_id, entity_type, remote_id),
    CONSTRAINT integration_outbox_events_connection_business_fk
        FOREIGN KEY (connection_id, business_id)
        REFERENCES integration_connections (id, business_id)
        ON DELETE CASCADE
);
CREATE INDEX idx_integration_outbox_due
    ON integration_outbox_events (next_attempt_at, created_at)
    WHERE status IN ('pending', 'failed');
CREATE INDEX idx_integration_outbox_connection
    ON integration_outbox_events (connection_id, status);

-- ---------------------------------------------------------------------------
-- Wave 5 — reconciliation snapshots (remote totals vs local ledger)
-- ---------------------------------------------------------------------------
CREATE TABLE integration_reconciliations (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    connection_id uuid NOT NULL,
    period_start  timestamptz NOT NULL,
    period_end    timestamptz NOT NULL,
    remote_order_count integer NOT NULL DEFAULT 0 CHECK (remote_order_count >= 0),
    remote_total_rial  bigint NOT NULL DEFAULT 0,
    local_order_count  integer NOT NULL DEFAULT 0 CHECK (local_order_count >= 0),
    local_total_rial   bigint NOT NULL DEFAULT 0,
    difference_rial    bigint NOT NULL DEFAULT 0,
    status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed')),
    created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT integration_reconciliations_connection_business_fk
        FOREIGN KEY (connection_id, business_id)
        REFERENCES integration_connections (id, business_id)
        ON DELETE CASCADE
);
CREATE INDEX idx_integration_reconciliations_connection
    ON integration_reconciliations (connection_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Audit trail — every connection change and every ingest/sync outcome
-- ---------------------------------------------------------------------------
CREATE TABLE integration_audit_log (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    connection_id uuid REFERENCES integration_connections(id) ON DELETE CASCADE,
    action        text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 120),
    entity_type   text,
    remote_id     text,
    local_id      uuid,
    payload       jsonb,
    error         text,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_integration_audit_log_connection
    ON integration_audit_log (connection_id, created_at DESC);
CREATE INDEX idx_integration_audit_log_business
    ON integration_audit_log (business_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- RLS — the standard template, one policy per table
-- ---------------------------------------------------------------------------
ALTER TABLE integration_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integration_connections FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE integration_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_webhook_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integration_webhook_events FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE integration_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integration_mappings FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE integration_outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_outbox_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integration_outbox_events FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE integration_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_reconciliations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integration_reconciliations FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE integration_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integration_audit_log FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- Feature flag — platform-gated, off by default like api_platform
-- ---------------------------------------------------------------------------
INSERT INTO feature_flags (key, name, description, default_enabled)
VALUES (
    'integrations',
    'اتصال فروشگاه آنلاین (ووکامرس)',
    'همگام‌سازی دوطرفه سفارش، محصول، مشتری، موجودی و قیمت با فروشگاه ووکامرس',
    false
)
ON CONFLICT (key) DO NOTHING;
