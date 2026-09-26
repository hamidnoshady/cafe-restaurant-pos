-- ============================================================================
-- 0177_billing_commercial_domain.sql — meters, usage ledger, price versions.
--
-- Migration 0176 made billing_plans the plan catalogue and business_wallets
-- the balance. This migration adds the domains that were still missing:
--
--   one meter catalogue, generic plan allowances, an append-only usage
--   ledger (feature_usage stays a counter, not the financial record),
--   versioned prices, an atomic invoice-number allocator, spend policy,
--   vendor cost, CMS service credentials and the entitlement projection.
--
-- Nothing here deletes a balance. Message credit is copied into the wallet
-- once, keyed so a repeated run cannot credit it twice. Website and media
-- charge tables stay as historical/idempotency records; new money moves
-- through the wallet and billing_invoices.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Meters (global catalogue — no business_id).
-- ---------------------------------------------------------------------------
CREATE TABLE billing_meters (
    key                     text PRIMARY KEY,
    name                    text NOT NULL,
    description             text NOT NULL DEFAULT '',
    unit                    text NOT NULL,
    aggregation             text NOT NULL
                                CHECK (aggregation IN ('sum', 'max', 'latest', 'average', 'byte_time', 'duration')),
    billing_period_behavior text NOT NULL DEFAULT 'reset'
                                CHECK (billing_period_behavior IN ('reset', 'high_water')),
    customer_visible        boolean NOT NULL DEFAULT true,
    billable                boolean NOT NULL DEFAULT true,
    active                  boolean NOT NULL DEFAULT true,
    source                  text NOT NULL CHECK (source IN ('platform', 'eshobe-cms', 'provider')),
    criticality             text NOT NULL DEFAULT 'noncritical'
                                CHECK (criticality IN ('critical', 'noncritical')),
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

INSERT INTO billing_meters (key, name, description, unit, aggregation, billing_period_behavior, customer_visible, billable, source, criticality)
VALUES
    ('ai.input_tokens', 'توکن ورودی هوش مصنوعی', 'توکن‌های ورودی یک درخواست تکمیل‌شده.', 'token', 'sum', 'reset', true, true, 'platform', 'noncritical'),
    ('ai.output_tokens', 'توکن خروجی هوش مصنوعی', 'توکن‌های خروجی یک درخواست تکمیل‌شده.', 'token', 'sum', 'reset', true, true, 'platform', 'noncritical'),
    ('ai.request', 'درخواست هوش مصنوعی', 'یک درخواست تکمیل‌شده به دستیار.', 'request', 'sum', 'reset', true, true, 'platform', 'noncritical'),
    ('ai.credit', 'اعتبار هوش مصنوعی', 'اعتبار ریالی مصرف‌شده پس از سهمیهٔ پلن.', 'rial', 'sum', 'reset', true, true, 'platform', 'noncritical'),
    ('messaging.sms_segment', 'قطعه پیامک', 'تعداد قطعات UCS-2 یک پیامک ارسالی.', 'segment', 'sum', 'reset', true, true, 'platform', 'noncritical'),
    ('messaging.email_send', 'ارسال ایمیل', 'یک ایمیل پذیرفته‌شده توسط سرویس‌دهنده.', 'send', 'sum', 'reset', true, true, 'platform', 'noncritical'),
    ('media.storage_byte_hour', 'نگهداری فایل', 'بایت-ساعت فضای ذخیره‌شده.', 'byte_hour', 'byte_time', 'reset', true, true, 'platform', 'critical'),
    ('media.image_enhance', 'بهسازی تصویر', 'یک اجرای بهسازی تصویر محصول.', 'image', 'sum', 'reset', true, true, 'provider', 'noncritical'),
    ('cms.bandwidth_bytes', 'ترافیک سایت', 'بایت خروجی تحویل‌داده‌شده به بازدیدکننده.', 'byte', 'sum', 'reset', true, true, 'eshobe-cms', 'critical'),
    ('cms.origin_transfer_bytes', 'انتقال از مبدأ', 'بایت خوانده‌شده از مبدأ.', 'byte', 'sum', 'reset', false, true, 'eshobe-cms', 'critical'),
    ('cms.api_request', 'درخواست API سایت', 'درخواست‌های API سایت‌ساز.', 'request', 'sum', 'reset', false, true, 'eshobe-cms', 'noncritical'),
    ('cms.storage_byte_hour', 'نگهداری فایل سایت', 'بایت-ساعت فایل‌های سایت.', 'byte_hour', 'byte_time', 'reset', true, true, 'eshobe-cms', 'critical'),
    ('cms.build_seconds', 'زمان ساخت سایت', 'ثانیه‌های یک ساخت تکمیل‌شده.', 'second', 'duration', 'reset', false, true, 'eshobe-cms', 'noncritical'),
    ('cms.deployment', 'انتشار سایت', 'یک انتشار تکمیل‌شده.', 'deployment', 'sum', 'reset', true, true, 'eshobe-cms', 'noncritical'),
    ('backup.storage_byte_day', 'نگهداری نسخهٔ پشتیبان', 'بایت-روز نسخه‌های پشتیبان.', 'byte_day', 'byte_time', 'high_water', true, true, 'platform', 'noncritical'),
    ('automation.run', 'اجرای خودکارسازی', 'یک اجرای تکمیل‌شدهٔ خودکارسازی.', 'run', 'sum', 'reset', true, true, 'platform', 'noncritical')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Generic allowances. AI's monthly_ai_credit_rial is copied here; the column
-- stays as the compatibility mirror that saveBillingPlan keeps in sync.
-- ---------------------------------------------------------------------------
CREATE TABLE billing_plan_meter_allowances (
    plan_key            text NOT NULL REFERENCES billing_plans(key) ON DELETE CASCADE,
    meter_key           text NOT NULL REFERENCES billing_meters(key),
    included_quantity   bigint NOT NULL DEFAULT 0 CHECK (included_quantity >= 0),
    overage_enabled     boolean NOT NULL DEFAULT true,
    hard_limit          bigint CHECK (hard_limit IS NULL OR hard_limit >= 0),
    soft_limit          bigint CHECK (soft_limit IS NULL OR soft_limit >= 0),
    reset_period        text NOT NULL DEFAULT 'month' CHECK (reset_period IN ('month', 'day', 'none')),
    sort_order          integer NOT NULL DEFAULT 0,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (plan_key, meter_key)
);

INSERT INTO billing_plan_meter_allowances (plan_key, meter_key, included_quantity, overage_enabled, reset_period)
SELECT key, 'ai.credit', monthly_ai_credit_rial, true, 'month'
  FROM billing_plans
 WHERE monthly_ai_credit_rial IS NOT NULL AND monthly_ai_credit_rial > 0
ON CONFLICT (plan_key, meter_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Versioned prices. unit_amount_rial is immutable after insert.
-- ---------------------------------------------------------------------------
CREATE TABLE billing_price_versions (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    target_type       text NOT NULL CHECK (target_type IN ('meter', 'plan', 'addon', 'capability')),
    target_key        text NOT NULL,
    currency          text NOT NULL DEFAULT 'IRR' CHECK (currency = 'IRR'),
    unit              text NOT NULL,
    unit_amount_rial  bigint NOT NULL CHECK (unit_amount_rial >= 0),
    unit_size         bigint NOT NULL DEFAULT 1 CHECK (unit_size > 0),
    effective_from    timestamptz NOT NULL DEFAULT now(),
    effective_until   timestamptz,
    version           integer NOT NULL CHECK (version > 0),
    metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by        uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (target_type, target_key, version),
    CHECK (effective_until IS NULL OR effective_until > effective_from)
);
CREATE INDEX idx_billing_price_versions_lookup
    ON billing_price_versions (target_type, target_key, effective_from DESC);

CREATE OR REPLACE FUNCTION billing_price_amount_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.unit_amount_rial IS DISTINCT FROM OLD.unit_amount_rial
       OR NEW.unit_size IS DISTINCT FROM OLD.unit_size
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.target_key IS DISTINCT FROM OLD.target_key THEN
        RAISE EXCEPTION 'billing_price_versions amounts are immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER billing_price_versions_immutable
    BEFORE UPDATE ON billing_price_versions
    FOR EACH ROW EXECUTE FUNCTION billing_price_amount_immutable();

-- Copy the live message rates and the media tariff into the first version
-- so a deployment that already set them does not lose them.
INSERT INTO billing_price_versions (target_type, target_key, unit, unit_amount_rial, unit_size, version, metadata)
SELECT 'meter', 'messaging.sms_segment', 'segment', sms_rial_per_segment, 1, 1, '{}'::jsonb
  FROM platform_message_config WHERE id
ON CONFLICT (target_type, target_key, version) DO NOTHING;

INSERT INTO billing_price_versions (target_type, target_key, unit, unit_amount_rial, unit_size, version, metadata)
SELECT 'meter', 'messaging.email_send', 'send', email_rial_per_send, 1, 1, '{}'::jsonb
  FROM platform_message_config WHERE id
ON CONFLICT (target_type, target_key, version) DO NOTHING;

INSERT INTO billing_price_versions (target_type, target_key, unit, unit_amount_rial, unit_size, version, metadata)
SELECT 'meter', 'media.storage_byte_hour', 'byte_hour', daily_flat_rial, 1, 1,
       jsonb_build_object(
           'billingEnabled', billing_enabled,
           'dailyFlatRial', daily_flat_rial,
           'dailyPerGbRial', daily_per_gb_rial,
           'freeQuotaMb', free_quota_mb,
           'enhancePriceRial', enhance_price_rial
       )
  FROM platform_media_config WHERE id
ON CONFLICT (target_type, target_key, version) DO NOTHING;

INSERT INTO billing_price_versions (target_type, target_key, unit, unit_amount_rial, unit_size, version)
SELECT 'meter', 'media.image_enhance', 'image', enhance_price_rial, 1, 1
  FROM platform_media_config WHERE id
ON CONFLICT (target_type, target_key, version) DO NOTHING;

INSERT INTO billing_price_versions (target_type, target_key, unit, unit_amount_rial, unit_size, version)
SELECT 'plan', key, 'month', monthly_price_rial, 1, 1
  FROM website_service_plans
 WHERE monthly_price_rial IS NOT NULL
ON CONFLICT (target_type, target_key, version) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Append-only usage ledger + ratings (ratings are a separate insert, so the
-- event row itself is never updated).
-- ---------------------------------------------------------------------------
CREATE TABLE billing_usage_events (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id         text NOT NULL,
    business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    meter_key        text NOT NULL REFERENCES billing_meters(key),
    source           text NOT NULL,
    resource_type    text,
    resource_id      text,
    quantity         bigint NOT NULL,
    unit             text NOT NULL,
    event_kind       text NOT NULL DEFAULT 'usage' CHECK (event_kind IN ('usage', 'correction')),
    occurred_at      timestamptz NOT NULL DEFAULT now(),
    period_start     timestamptz,
    period_end       timestamptz,
    dimensions       jsonb NOT NULL DEFAULT '{}'::jsonb,
    source_reference text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    CHECK (
        (event_kind = 'usage' AND quantity > 0)
        OR (event_kind = 'correction' AND quantity <> 0)
    ),
    UNIQUE (source, event_id)
);
CREATE INDEX idx_billing_usage_events_business
    ON billing_usage_events (business_id, meter_key, occurred_at DESC);

-- Application code must not rewrite a usage quantity. DELETE is allowed so
-- removing a business can cascade; there is no application DELETE path.
CREATE OR REPLACE FUNCTION billing_usage_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'billing_usage_events are append-only';
END;
$$;

CREATE TRIGGER billing_usage_events_no_update
    BEFORE UPDATE ON billing_usage_events
    FOR EACH ROW EXECUTE FUNCTION billing_usage_events_append_only();

CREATE TABLE billing_usage_ratings (
    usage_event_id      uuid PRIMARY KEY REFERENCES billing_usage_events(id) ON DELETE CASCADE,
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    price_version_id    uuid REFERENCES billing_price_versions(id) ON DELETE SET NULL,
    rated_amount_rial   bigint NOT NULL DEFAULT 0 CHECK (rated_amount_rial >= 0),
    allowance_quantity  bigint NOT NULL DEFAULT 0 CHECK (allowance_quantity >= 0),
    overage_quantity    bigint NOT NULL DEFAULT 0 CHECK (overage_quantity >= 0),
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_billing_usage_ratings_business
    ON billing_usage_ratings (business_id, created_at DESC);

CREATE TABLE billing_usage_rollups_daily (
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    meter_key    text NOT NULL REFERENCES billing_meters(key),
    day          date NOT NULL,
    quantity     bigint NOT NULL DEFAULT 0,
    event_count  integer NOT NULL DEFAULT 0,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, meter_key, day)
);

CREATE TABLE billing_usage_rollups_hourly (
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    meter_key    text NOT NULL REFERENCES billing_meters(key),
    hour         timestamptz NOT NULL,
    quantity     bigint NOT NULL DEFAULT 0,
    event_count  integer NOT NULL DEFAULT 0,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, meter_key, hour)
);

CREATE TABLE billing_usage_rollups_cycle (
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    meter_key     text NOT NULL REFERENCES billing_meters(key),
    period_start  timestamptz NOT NULL,
    period_end    timestamptz NOT NULL,
    quantity      bigint NOT NULL DEFAULT 0,
    rated_rial    bigint NOT NULL DEFAULT 0,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, meter_key, period_start)
);

-- ---------------------------------------------------------------------------
-- Invoice numbers — one counter row per YYYYMM, locked by the upsert.
-- ---------------------------------------------------------------------------
CREATE TABLE billing_invoice_counters (
    period_key  text PRIMARY KEY,
    last_value  bigint NOT NULL CHECK (last_value >= 0)
);

WITH numbered AS (
    SELECT invoice_number,
           row_number() OVER (PARTITION BY invoice_number ORDER BY created_at, id) AS n
      FROM billing_invoices
     WHERE invoice_number IS NOT NULL
)
UPDATE billing_invoices i
   SET invoice_number = i.invoice_number || '-' || n.n::text
  FROM numbered n
 WHERE i.invoice_number = n.invoice_number AND n.n > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_invoices_number
    ON billing_invoices (invoice_number);

INSERT INTO billing_invoice_counters (period_key, last_value)
SELECT substring(invoice_number FROM 5 FOR 6),
       MAX(substring(invoice_number FROM 12 FOR 8)::bigint)
  FROM billing_invoices
 WHERE invoice_number ~ '^INV-[0-9]{6}-[0-9]+$'
 GROUP BY 1
ON CONFLICT (period_key) DO UPDATE
   SET last_value = GREATEST(billing_invoice_counters.last_value, EXCLUDED.last_value);

ALTER TABLE billing_invoices
    DROP CONSTRAINT IF EXISTS billing_invoices_paid_lte_total;
ALTER TABLE billing_invoices
    ADD CONSTRAINT billing_invoices_paid_lte_total CHECK (paid_rial <= total_rial);

ALTER TABLE business_subscriptions
    ADD COLUMN IF NOT EXISTS trial_started_at timestamptz;

UPDATE business_subscriptions
   SET trial_started_at = started_at
 WHERE trial_end IS NOT NULL AND trial_started_at IS NULL;

-- ---------------------------------------------------------------------------
-- Commercial settings (singleton).
-- ---------------------------------------------------------------------------
CREATE TABLE billing_commercial_settings (
    id                    boolean PRIMARY KEY DEFAULT true CHECK (id),
    billing_time_zone     text NOT NULL DEFAULT 'Asia/Tehran',
    currency              text NOT NULL DEFAULT 'IRR' CHECK (currency = 'IRR'),
    invoice_prefix        text NOT NULL DEFAULT 'INV',
    default_due_days      integer NOT NULL DEFAULT 7 CHECK (default_due_days >= 0),
    default_grace_days    integer NOT NULL DEFAULT 7 CHECK (default_grace_days >= 0),
    rounding              text NOT NULL DEFAULT 'ceil' CHECK (rounding IN ('ceil', 'floor')),
    minimum_top_up_rial   bigint NOT NULL DEFAULT 100000 CHECK (minimum_top_up_rial >= 0),
    overage_policy        text NOT NULL DEFAULT 'charge' CHECK (overage_policy IN ('charge', 'block')),
    proration_policy      text NOT NULL DEFAULT 'none' CHECK (proration_policy IN ('none', 'daily')),
    default_spend_action  text NOT NULL DEFAULT 'warn_only'
                              CHECK (default_spend_action IN ('continue', 'warn_only', 'block_noncritical', 'throttle_noncritical')),
    tax_rate_bps          integer NOT NULL DEFAULT 0 CHECK (tax_rate_bps >= 0 AND tax_rate_bps <= 10000),
    invoice_footer        text NOT NULL DEFAULT '',
    updated_at            timestamptz NOT NULL DEFAULT now()
);
INSERT INTO billing_commercial_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Spend policy, vendor cost, auditable adjustments.
-- ---------------------------------------------------------------------------
CREATE TABLE business_spend_policies (
    business_id           uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
    monthly_budget_rial   bigint CHECK (monthly_budget_rial IS NULL OR monthly_budget_rial >= 0),
    thresholds            integer[] NOT NULL DEFAULT ARRAY[50, 75, 90, 100],
    action_at_limit       text NOT NULL DEFAULT 'warn_only'
                              CHECK (action_at_limit IN ('continue', 'warn_only', 'block_noncritical', 'throttle_noncritical')),
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE billing_vendor_cost_events (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id        uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    meter_key          text REFERENCES billing_meters(key),
    provider           text NOT NULL,
    source_reference   text NOT NULL,
    currency           text NOT NULL DEFAULT 'IRR',
    amount_rial        bigint NOT NULL CHECK (amount_rial >= 0),
    occurred_at        timestamptz NOT NULL DEFAULT now(),
    metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, source_reference)
);
CREATE INDEX idx_billing_vendor_cost_business
    ON billing_vendor_cost_events (business_id, occurred_at DESC);

CREATE TABLE billing_adjustments (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    invoice_id    uuid REFERENCES billing_invoices(id) ON DELETE SET NULL,
    amount_rial   bigint NOT NULL CHECK (amount_rial <> 0),
    reason        text NOT NULL CHECK (length(trim(reason)) > 0),
    created_by    uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_billing_adjustments_business
    ON billing_adjustments (business_id, created_at DESC);

-- Same rule as usage events: no application rewrite, cascade delete on the
-- business row remains possible.
CREATE OR REPLACE FUNCTION billing_adjustments_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'billing_adjustments are append-only';
END;
$$;

CREATE TRIGGER billing_adjustments_no_update
    BEFORE UPDATE ON billing_adjustments
    FOR EACH ROW EXECUTE FUNCTION billing_adjustments_append_only();

-- ---------------------------------------------------------------------------
-- CMS → billing credential. The secret is encrypted; the scope cannot be
-- widened to wallet, invoice or plan administration.
-- ---------------------------------------------------------------------------
CREATE TABLE billing_service_credentials (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key_id      text NOT NULL UNIQUE,
    secret_enc  text NOT NULL,
    scope       text NOT NULL DEFAULT 'billing.usage.write'
                    CHECK (scope = 'billing.usage.write'),
    label       text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    revoked_at  timestamptz
);

CREATE TABLE billing_service_nonces (
    key_id   text NOT NULL,
    nonce    text NOT NULL,
    seen_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (key_id, nonce)
);

-- ---------------------------------------------------------------------------
-- Entitlement projection the CMS caches. version only moves forward.
-- ---------------------------------------------------------------------------
CREATE TABLE cms_entitlement_projections (
    site_id      text PRIMARY KEY,
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    version      bigint NOT NULL CHECK (version > 0),
    payload      jsonb NOT NULL,
    synced_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_cms_entitlement_projections_business
    ON cms_entitlement_projections (business_id);

-- ---------------------------------------------------------------------------
-- Wallet feature keys used by the consolidated chargers.
-- ---------------------------------------------------------------------------
INSERT INTO feature_flags (key, name, description, default_enabled) VALUES
    ('messaging', 'پیام‌رسانی', 'ارسال پیامک و ایمیل از اعتبار کیف پول پلتفرم', true),
    ('website_service', 'مدیریت وب‌سایت', 'هزینهٔ سایت از کیف پول پلتفرم', true),
    ('accounting.orders', 'سفارش و فروش', 'قابلیت ثابت سفارش و فروش', true),
    ('accounting.inventory', 'انبار', 'قابلیت ثابت انبار', true),
    ('accounting.products', 'محصولات', 'قابلیت ثابت محصولات', true),
    ('accounting.operations', 'عملیات', 'قابلیت ثابت عملیات روزانه', true),
    ('accounting.ledger', 'دفتر', 'قابلیت ثابت دفتر', true),
    ('accounting.parties', 'طرف‌حساب‌ها', 'قابلیت ثابت طرف‌حساب', true),
    ('accounting.reports', 'گزارش‌ها', 'قابلیت ثابت گزارش', true),
    ('accounting.settings', 'تنظیمات', 'قابلیت ثابت تنظیمات', true),
    ('crm.workspace', 'مدیریت مشتریان', 'قابلیت ثابت CRM', true),
    ('growth.loyalty', 'وفاداری', 'قابلیت ثابت وفاداری و تبلیغات', true),
    ('operations.shared', 'ابزارهای مشترک', 'ابزارهای مشترک پلتفرم', true),
    ('retail.trades', 'خرده‌فروشی', 'قابلیت‌های صنفی', true),
    ('integrations.api', 'اتصال‌ها', 'API و اتصال‌های فنی', true)
ON CONFLICT (key) DO NOTHING;

INSERT INTO billing_plan_features (plan_key, feature_key, pricing_model, price_rial, sort_order)
SELECT p.key, f.key, 'included', 0, 0
  FROM billing_plans p
  JOIN feature_flags f ON f.key IN (
      'accounting.orders', 'accounting.inventory', 'accounting.products', 'accounting.operations',
      'accounting.ledger', 'accounting.parties', 'accounting.reports', 'accounting.settings',
      'crm.workspace', 'growth.loyalty', 'operations.shared', 'retail.trades', 'integrations.api'
  )
 WHERE p.status = 'active'
ON CONFLICT (plan_key, feature_key) DO NOTHING;

-- Idempotent copy of a positive message-credit balance into the wallet.
-- The legacy ledger is left in place as history and is not a second balance.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_ledger_migration_key
    ON wallet_ledger (business_id, (metadata->>'migrationKey'))
    WHERE metadata ? 'migrationKey';

DO $$
DECLARE
    rec record;
    new_balance bigint;
BEGIN
    FOR rec IN
        SELECT business_id, SUM(amount_rial)::bigint AS bal
          FROM message_credit_ledger
         GROUP BY business_id
    LOOP
        IF rec.bal > 0 AND NOT EXISTS (
            SELECT 1 FROM wallet_ledger
             WHERE business_id = rec.business_id
               AND metadata->>'migrationKey' = '0177_message_credit'
        ) THEN
            INSERT INTO business_wallets (business_id) VALUES (rec.business_id)
            ON CONFLICT (business_id) DO NOTHING;
            UPDATE business_wallets
               SET balance_rial = balance_rial + rec.bal,
                   total_topped_up_rial = total_topped_up_rial + rec.bal,
                   updated_at = now()
             WHERE business_id = rec.business_id
            RETURNING balance_rial INTO new_balance;
            INSERT INTO wallet_ledger
                (business_id, kind, direction, amount_rial, balance_after_rial, feature_key, note, metadata)
            VALUES
                (rec.business_id, 'admin_grant', 'credit', rec.bal, new_balance, 'messaging',
                 'انتقال ماندهٔ اعتبار پیام به کیف پول پلتفرم',
                 jsonb_build_object('migrationKey', '0177_message_credit'));
        ELSIF rec.bal < 0 AND NOT EXISTS (
            SELECT 1 FROM billing_adjustments
             WHERE business_id = rec.business_id
               AND reason = 'message_credit_debt_0177'
        ) THEN
            INSERT INTO billing_adjustments (business_id, amount_rial, reason)
            VALUES (rec.business_id, rec.bal, 'message_credit_debt_0177');
        END IF;
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE billing_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_usage_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing_usage_events FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE billing_usage_ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_usage_ratings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing_usage_ratings FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE billing_usage_rollups_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_usage_rollups_daily FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing_usage_rollups_daily FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE billing_usage_rollups_hourly ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_usage_rollups_hourly FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing_usage_rollups_hourly FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE billing_usage_rollups_cycle ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_usage_rollups_cycle FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing_usage_rollups_cycle FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE business_spend_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_spend_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON business_spend_policies FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE billing_vendor_cost_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_vendor_cost_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing_vendor_cost_events FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE billing_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_adjustments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing_adjustments FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE cms_entitlement_projections ENABLE ROW LEVEL SECURITY;
ALTER TABLE cms_entitlement_projections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cms_entitlement_projections FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
