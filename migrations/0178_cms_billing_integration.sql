-- ============================================================================
-- 0178_cms_billing_integration.sql — PLATFORM↔CMS billing contract alignment,
-- entitlement delivery outbox, and CMS outbound credential storage.
-- ============================================================================

-- Inbound service credentials may hold either ingest or entitlement scopes on
-- the CMS side; platform issues usage.write keys for CMS → platform ingest.
ALTER TABLE billing_service_credentials
    DROP CONSTRAINT IF EXISTS billing_service_credentials_scope_check;
ALTER TABLE billing_service_credentials
    ADD CONSTRAINT billing_service_credentials_scope_check
        CHECK (scope IN ('billing.usage.write', 'billing.entitlement.write'));

-- Replay guard for the v1 signature protocol (`key_id` + body fingerprint).
CREATE TABLE billing_service_replays (
    key_id       text NOT NULL,
    fingerprint  text NOT NULL,
    seen_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (key_id, fingerprint)
);

-- Align meter catalogue with eshobe-cms (`cms.build_second`).
UPDATE billing_meters SET key = 'cms.build_second' WHERE key = 'cms.build_seconds';
UPDATE billing_plan_meter_allowances SET meter_key = 'cms.build_second' WHERE meter_key = 'cms.build_seconds';
UPDATE billing_usage_events SET meter_key = 'cms.build_second' WHERE meter_key = 'cms.build_seconds';
UPDATE billing_usage_rollups_daily SET meter_key = 'cms.build_second' WHERE meter_key = 'cms.build_seconds';
UPDATE billing_price_versions SET target_key = 'cms.build_second'
 WHERE target_type = 'meter' AND target_key = 'cms.build_seconds';

INSERT INTO billing_meters (key, name, description, unit, aggregation, billing_period_behavior,
                            customer_visible, billable, active, source, criticality)
VALUES (
    'cms.build_second',
    'زمان ساخت سایت',
    'ثانیه‌های یک ساخت تکمیل‌شده.',
    'second',
    'duration',
    'reset',
    false,
    true,
    true,
    'eshobe-cms',
    'noncritical'
)
ON CONFLICT (key) DO NOTHING;

DELETE FROM billing_meters WHERE key = 'cms.build_seconds';

-- CMS pushes entitlement projections back through platform storage + outbox.
ALTER TABLE cms_entitlement_projections
    ADD COLUMN IF NOT EXISTS last_delivered_version bigint,
    ADD COLUMN IF NOT EXISTS last_delivery_at timestamptz;

CREATE TABLE cms_entitlement_outbox (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id          text NOT NULL,
    business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    version          bigint NOT NULL CHECK (version > 0),
    payload          jsonb NOT NULL,
    status           text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'dead_letter')),
    attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at  timestamptz NOT NULL DEFAULT now(),
    last_error       text,
    delivered_at     timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (site_id, version)
);

CREATE INDEX idx_cms_entitlement_outbox_drain
    ON cms_entitlement_outbox (next_attempt_at, created_at)
    WHERE status IN ('pending', 'failed');

ALTER TABLE cms_entitlement_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE cms_entitlement_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cms_entitlement_outbox FOR ALL
    USING (business_id = current_setting('app.current_business_id', true)::uuid)
    WITH CHECK (business_id = current_setting('app.current_business_id', true)::uuid);

-- Outbound `billing.entitlement.write` credential issued by CMS (encrypted at rest).
ALTER TABLE platform_cms_config
    ADD COLUMN IF NOT EXISTS billing_entitlement_key_id text NOT NULL DEFAULT ''
        CHECK (char_length(billing_entitlement_key_id) <= 120),
    ADD COLUMN IF NOT EXISTS billing_entitlement_secret_ciphertext text,
    ADD COLUMN IF NOT EXISTS billing_entitlement_secret_hint text NOT NULL DEFAULT ''
        CHECK (char_length(billing_entitlement_secret_hint) <= 12);
