-- Phase 18 — platform-owned AI configuration, metered credits, subscriptions
-- and manual top-up requests.
--
-- Global catalogue/configuration tables intentionally have no RLS: they carry
-- no tenant column and are supervised only by the platform-admin realm.
-- Every business-owned table below has a forced RLS policy in this same
-- migration; the Phase 17 generated isolation test must keep proving it.

CREATE TABLE platform_ai_config (
    id                              boolean PRIMARY KEY DEFAULT true CHECK (id),
    enabled                         boolean NOT NULL DEFAULT false,
    provider                        text NOT NULL DEFAULT 'openrouter'
                                        CHECK (provider IN ('openrouter', 'arvan')),
    model                           text NOT NULL DEFAULT 'openai/gpt-4o-mini',
    base_url                        text NOT NULL DEFAULT 'https://openrouter.ai/api/v1',
    api_key                         text,
    temperature                     numeric(3,2) NOT NULL DEFAULT 0.30
                                        CHECK (temperature >= 0 AND temperature <= 2),
    input_token_rial_per_million    bigint NOT NULL DEFAULT 0
                                        CHECK (input_token_rial_per_million >= 0),
    output_token_rial_per_million   bigint NOT NULL DEFAULT 0
                                        CHECK (output_token_rial_per_million >= 0),
    max_turn_rial                   bigint NOT NULL DEFAULT 0 CHECK (max_turn_rial >= 0),
    credit_unit_rial                bigint NOT NULL DEFAULT 0 CHECK (credit_unit_rial >= 0),
    max_output_tokens               integer NOT NULL DEFAULT 1000
                                        CHECK (max_output_tokens BETWEEN 64 AND 8192),
    updated_at                      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_credit_packages (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name                text NOT NULL CHECK (length(trim(name)) > 0),
    price_rial          bigint NOT NULL CHECK (price_rial > 0),
    credit_amount_rial  bigint NOT NULL CHECK (credit_amount_rial > 0),
    is_active           boolean NOT NULL DEFAULT true,
    sort_order          integer NOT NULL DEFAULT 0,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_credit_packages_catalogue
    ON ai_credit_packages (is_active, sort_order, created_at);

CREATE TABLE ai_subscription_plans (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name                  text NOT NULL CHECK (length(trim(name)) > 0),
    price_rial            bigint NOT NULL CHECK (price_rial > 0),
    monthly_credit_rial   bigint NOT NULL CHECK (monthly_credit_rial > 0),
    is_active             boolean NOT NULL DEFAULT true,
    sort_order            integer NOT NULL DEFAULT 0,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_subscription_plans_catalogue
    ON ai_subscription_plans (is_active, sort_order, created_at);

CREATE TABLE ai_business_billing (
    business_id               uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
    balance_rial              bigint NOT NULL DEFAULT 0 CHECK (balance_rial >= 0),
    subscription_plan_id      uuid REFERENCES ai_subscription_plans(id) ON DELETE SET NULL,
    subscription_renews_at    timestamptz,
    updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_credit_ledger (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id           uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    kind                  text NOT NULL CHECK (kind IN (
                              'manual_grant',
                              'top_up',
                              'subscription',
                              'usage',
                              'usage_refund',
                              'usage_cancelled'
                          )),
    amount_rial           bigint NOT NULL,
    actual_cost_rial      bigint CHECK (actual_cost_rial IS NULL OR actual_cost_rial >= 0),
    request_id            uuid,
    input_tokens          integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
    output_tokens         integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
    note                  text,
    metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
    platform_admin_id     uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_credit_ledger_business_created
    ON ai_credit_ledger (business_id, created_at DESC);
CREATE INDEX idx_ai_credit_ledger_request
    ON ai_credit_ledger (request_id) WHERE request_id IS NOT NULL;
CREATE UNIQUE INDEX idx_ai_credit_ledger_one_usage_reservation
    ON ai_credit_ledger (request_id) WHERE kind = 'usage';

CREATE TABLE ai_top_up_requests (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id           uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    package_id            uuid REFERENCES ai_credit_packages(id) ON DELETE SET NULL,
    package_name          text NOT NULL,
    price_rial            bigint NOT NULL CHECK (price_rial > 0),
    credit_amount_rial    bigint NOT NULL CHECK (credit_amount_rial > 0),
    note                  text,
    status                text NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'approved', 'rejected')),
    reviewed_by           uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    reviewed_at           timestamptz,
    fulfilled_ledger_id   uuid REFERENCES ai_credit_ledger(id) ON DELETE SET NULL,
    created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_top_up_requests_pending
    ON ai_top_up_requests (status, created_at) WHERE status = 'pending';
CREATE INDEX idx_ai_top_up_requests_business_created
    ON ai_top_up_requests (business_id, created_at DESC);

ALTER TABLE ai_business_billing ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_business_billing FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_business_billing FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE ai_credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_credit_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_credit_ledger FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE ai_top_up_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_top_up_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_top_up_requests FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- The former per-business BYO-key value must not survive as a confusing,
-- unused second configuration path after the platform-owned cutover.
DELETE FROM settings WHERE key = 'ai.config';
