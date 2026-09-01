-- Platform billing: business wallet credits, plan builder (per-feature pricing
-- with free-for-time / free-for-use promotions), and online payment gateways
-- (Zarinpal) for receiving credit top-ups and plan purchases.
--
-- Money is integer Rial everywhere, same convention as the rest of the
-- platform. Global catalogue/config tables (payment config, credit packages,
-- billing plans + their feature prices) intentionally have no RLS: they carry
-- no tenant column and are supervised by the platform-admin realm, exactly
-- like `feature_flags` and `plans` (see migrations 0020 / 0034). Business-
-- owned tables (wallet, ledger, billing_payments, entitlements, usage) get the same
-- forced-RLS tenant policy the AI billing tables use (migration 0039).

-- ---------------------------------------------------------------------------
-- Payment gateway configuration (single row, edited by the super-admin)
-- ---------------------------------------------------------------------------
CREATE TABLE platform_payment_config (
    id                    boolean PRIMARY KEY DEFAULT true CHECK (id),
    -- 'zarinpal' is the shipped Iranian gateway; 'manual' keeps the old
    -- request-and-approve flow as a fallback when no merchant is set yet.
    gateway               text NOT NULL DEFAULT 'manual'
                              CHECK (gateway IN ('manual', 'zarinpal')),
    -- Zarinpal merchant ID (UUID). Empty while the gateway is unset.
    merchant_id           text NOT NULL DEFAULT '',
    -- true → payment.zarinpal.com (live); false → sandbox.zarinpal.com.
    sandbox               boolean NOT NULL DEFAULT true,
    -- Where the gateway sends the browser back after payment.
    callback_url          text NOT NULL DEFAULT '',
    currency              text NOT NULL DEFAULT 'IRR' CHECK (currency IN ('IRR', 'IRT')),
    updated_by            uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    updated_at            timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform_payment_config (id) VALUES (true);

-- ---------------------------------------------------------------------------
-- Wallet credit packages (top-up catalogue)
-- ---------------------------------------------------------------------------
CREATE TABLE credit_packages (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name                text NOT NULL CHECK (length(trim(name)) > 0),
    price_rial          bigint NOT NULL CHECK (price_rial > 0),
    credit_rial         bigint NOT NULL CHECK (credit_rial > 0),
    is_active           boolean NOT NULL DEFAULT true,
    sort_order          integer NOT NULL DEFAULT 0,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_credit_packages_catalogue
    ON credit_packages (is_active, sort_order, created_at);

INSERT INTO credit_packages (name, price_rial, credit_rial, sort_order) VALUES
    ('بستهٔ ۱۰۰ هزار تومانی',  1_000_000,  1_000_000,  10),
    ('بستهٔ ۵۰۰ هزار تومانی',  5_000_000,  5_200_000,  20),
    ('بستهٔ ۱ میلیون تومانی', 10_000_000, 11_000_000,  30),
    ('بستهٔ ۵ میلیون تومانی', 50_000_000, 57_500_000,  40);

-- ---------------------------------------------------------------------------
-- Plan builder: billing plans and the per-feature price catalogue
-- ---------------------------------------------------------------------------
-- A billing plan is a *bundle of feature prices*. The business's active plan
-- is still `businesses.plan` (keyed by text, migration 0020); this table
-- extends that catalogue with price metadata instead of replacing it.
CREATE TABLE billing_plans (
    key                 text PRIMARY KEY,
    name                text NOT NULL CHECK (length(trim(name)) > 0),
    description         text,
    -- Plan-level monthly price. A feature may still carry a per-use price on
    -- top of an included plan (metered features); NULL price = no plan fee.
    monthly_price_rial  bigint CHECK (monthly_price_rial IS NULL OR monthly_price_rial >= 0),
    is_active           boolean NOT NULL DEFAULT true,
    sort_order          integer NOT NULL DEFAULT 0,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- The feature catalogue the plan builder picks from. Reuses `feature_flags`
-- keys so a price row and an entitlement flag always name the same thing.
CREATE TABLE billing_plan_features (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_key            text NOT NULL REFERENCES billing_plans(key) ON DELETE CASCADE,
    feature_key         text NOT NULL REFERENCES feature_flags(key) ON DELETE CASCADE,
    pricing_model       text NOT NULL DEFAULT 'included'
                            CHECK (pricing_model IN (
                              'included',   -- part of the plan, no extra charge
                              'monthly',    -- costs `price_rial` per month
                              'per_use',    -- costs `price_rial` each use, from wallet
                              'addon'       -- one-off purchase, then owned
                            )),
    price_rial          bigint NOT NULL DEFAULT 0 CHECK (price_rial >= 0),
    -- Free promotion: when set, the feature is free until the deadline and/or
    -- until `free_limit` uses are consumed. Either side may be NULL (time-only
    -- or usage-only); both NULL = no promotion.
    free_until          timestamptz,
    free_limit          integer CHECK (free_limit IS NULL OR free_limit >= 0),
    sort_order          integer NOT NULL DEFAULT 0,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (plan_key, feature_key)
);
CREATE INDEX idx_billing_plan_features_plan
    ON billing_plan_features (plan_key, sort_order);

-- Seed billing plans that mirror the three tiers in `plans` (0034). Existing
-- businesses keep their current plan key; price rows are added by the
-- super-admin through the plan builder.
INSERT INTO billing_plans (key, name, description, monthly_price_rial, sort_order) VALUES
    ('free',     'رایگان',    'شروع کار؛ قابلیت‌های پایه',                 0, 10),
    ('pro',      'حرفه‌ای',   'پرتکرارترین قابلیت‌ها برای یک کسب‌وکار فعال', 30_000_000, 20),
    ('business', 'سازمانی',   'همهٔ قابلیت‌ها بدون سقف',                    150_000_000, 30)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Business wallet + ledger
-- ---------------------------------------------------------------------------
CREATE TABLE business_wallets (
    business_id         uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
    balance_rial        bigint NOT NULL DEFAULT 0 CHECK (balance_rial >= 0),
    -- Lifetime totals for the billing page header.
    total_topped_up_rial  bigint NOT NULL DEFAULT 0 CHECK (total_topped_up_rial >= 0),
    total_spent_rial      bigint NOT NULL DEFAULT 0 CHECK (total_spent_rial >= 0),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wallet_ledger (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- credit: top-up, plan purchase grant, admin grant, refund.
    -- debit:  feature per-use charge, addon purchase, plan fee, admin adjust.
    kind                text NOT NULL CHECK (kind IN (
                            'top_up', 'payment', 'admin_grant', 'refund',
                            'feature_charge', 'addon_purchase', 'plan_fee',
                            'subscription', 'admin_adjust', 'free_promo'
                        )),
    direction           text NOT NULL CHECK (direction IN ('credit', 'debit')),
    amount_rial         bigint NOT NULL CHECK (amount_rial > 0),
    balance_after_rial  bigint NOT NULL CHECK (balance_after_rial >= 0),
    feature_key         text REFERENCES feature_flags(key) ON DELETE SET NULL,
    payment_id          uuid,
    note                text,
    metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
    platform_admin_id   uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_wallet_ledger_business_created
    ON wallet_ledger (business_id, created_at DESC);
CREATE INDEX idx_wallet_ledger_feature
    ON wallet_ledger (business_id, feature_key, created_at DESC);
-- A verified payment may post at most one ledger entry.
CREATE UNIQUE INDEX idx_wallet_ledger_one_payment_entry
    ON wallet_ledger (payment_id) WHERE payment_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Payment transactions (top-ups and plan/feature purchases via gateway)
-- ---------------------------------------------------------------------------
CREATE TABLE billing_payments (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    gateway             text NOT NULL DEFAULT 'zarinpal'
                            CHECK (gateway IN ('manual', 'zarinpal')),
    purpose             text NOT NULL CHECK (purpose IN ('top_up', 'plan_purchase', 'addon_purchase'))
                            DEFAULT 'top_up',
    -- For top_ups: credit package (price may still be custom/free entry).
    package_id          uuid REFERENCES credit_packages(id) ON DELETE SET NULL,
    -- For plan_purchase / addon_purchase.
    plan_key            text,
    feature_key         text,
    amount_rial         bigint NOT NULL CHECK (amount_rial > 0),
    credit_rial         bigint NOT NULL CHECK (credit_rial >= 0),
    description         text NOT NULL DEFAULT '',
    status              text NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'redirect', 'verified', 'failed', 'cancelled')),
    -- Gateway-side authority/authority token.
    authority           text,
    gateway_ref         text,          -- RefID (Zarinpal) once verified
    gateway_status      text,
    -- Fallback for the 'manual' gateway: an admin approves/rejects by hand.
    reviewed_by         uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    reviewed_at         timestamptz,
    created_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    verified_at         timestamptz
);
CREATE INDEX idx_payments_business_created
    ON billing_payments (business_id, created_at DESC);
CREATE INDEX idx_payments_pending
    ON billing_payments (status, created_at) WHERE status IN ('pending', 'redirect');
CREATE UNIQUE INDEX idx_payments_authority
    ON billing_payments (authority) WHERE authority IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Entitlements: features a business owns outright / through its plan, with
-- optional free-promotion windows; plus per-feature usage counters.
-- ---------------------------------------------------------------------------
CREATE TABLE business_entitlements (
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    feature_key         text NOT NULL REFERENCES feature_flags(key) ON DELETE CASCADE,
    -- How the feature was acquired.
    source              text NOT NULL CHECK (source IN ('plan', 'addon', 'promo', 'manual'))
                            DEFAULT 'plan',
    -- Add-ons and plans can expire; NULL = never.
    expires_at          timestamptz,
    -- Free-promotion limits copied from the plan at grant time (NULL = none).
    free_until          timestamptz,
    free_limit          integer CHECK (free_limit IS NULL OR free_limit >= 0),
    granted_by          uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, feature_key)
);

CREATE TABLE feature_usage (
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    feature_key         text NOT NULL REFERENCES feature_flags(key) ON DELETE CASCADE,
    period_started_at   timestamptz NOT NULL DEFAULT now(),
    used_count          bigint NOT NULL DEFAULT 0 CHECK (used_count >= 0),
    charged_count       bigint NOT NULL DEFAULT 0 CHECK (charged_count >= 0),
    spent_rial          bigint NOT NULL DEFAULT 0 CHECK (spent_rial >= 0),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, feature_key)
);

-- ---------------------------------------------------------------------------
-- RLS — same tenant policy shape as migration 0039.
-- ---------------------------------------------------------------------------
ALTER TABLE business_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_wallets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON business_wallets FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE wallet_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON wallet_ledger FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE billing_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing_payments FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE business_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_entitlements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON business_entitlements FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE feature_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON feature_usage FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
