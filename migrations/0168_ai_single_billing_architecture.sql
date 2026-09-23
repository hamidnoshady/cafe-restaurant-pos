-- ============================================================================
-- 0168_ai_single_billing_architecture.sql — ONE AI billing system.
--
-- The audit that produced this migration found the platform duplicating
-- LiteLLM's own job in two places:
--
--   1. platform_ai_gateway carried console mirrors of proxy-side settings
--      (routing_strategy, default_max_budget_usd, default_budget_duration,
--      default_tpm_limit, default_rpm_limit). None of them ever reached the
--      proxy at request time — routing lives in the proxy's config.yaml and
--      per-key budgets/rate limits are minted onto the virtual keys. Worse,
--      the mirrored budgets were APPLIED: keys were minted with max_budget,
--      so a business whose LiteLLM key budget ran out got a proxy 429
--      («سرویس هوش مصنوعی خطا داد») while its platform wallet still had
--      credit — two billing systems disagreeing, and the wrong one winning.
--
--   2. ai_business_gateway mirrored per-key max_budget_usd / budget_duration /
--      tpm_limit / rpm_limit, duplicating what LiteLLM enforces on the key
--      itself and what its config governs per deployment.
--
-- Ownership after this migration (the one architecture):
--   LiteLLM owns:  routing, model catalogue + limits, RPM/TPM, provider keys,
--                  per-key budgets WHEN an operator sets them in the gateway.
--   Platform owns: tenant credit (business_wallets — the ONE balance),
--                  pricing read-back (USD→Rial + margin), usage logs
--                  (ai_wallet_settlements), entitlement (ai_assistant flag),
--                  and the plan-included monthly AI credit introduced here.
--
-- Plan Builder integration (Parts 6 of the rebuild): billing_plans gains
-- `monthly_ai_credit_rial` — the AI credit a plan includes per calendar
-- month, spent BEFORE the wallet. Consumption is tracked in
-- ai_plan_allowance_usage, one row per (business, calendar month), written
-- inside the same row-locked wallet transaction that settles the turn.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Stop mirroring proxy-side settings on the platform gateway row.
-- ---------------------------------------------------------------------------
ALTER TABLE platform_ai_gateway
    DROP COLUMN IF EXISTS routing_strategy,
    DROP COLUMN IF EXISTS default_max_budget_usd,
    DROP COLUMN IF EXISTS default_budget_duration,
    DROP COLUMN IF EXISTS default_tpm_limit,
    DROP COLUMN IF EXISTS default_rpm_limit;

-- ---------------------------------------------------------------------------
-- 2. Stop mirroring per-key budgets/rate limits on the business gateway row.
--    The row keeps what only the platform knows: the minted key, its alias,
--    the business/branch model choice and the diagnostic spend figure.
-- ---------------------------------------------------------------------------
ALTER TABLE ai_business_gateway
    DROP COLUMN IF EXISTS max_budget_usd,
    DROP COLUMN IF EXISTS budget_duration,
    DROP COLUMN IF EXISTS tpm_limit,
    DROP COLUMN IF EXISTS rpm_limit;

-- ---------------------------------------------------------------------------
-- 3. Plan-included monthly AI credit (Plan Builder).
--
--    NULL / 0 = the plan includes no AI credit; every turn bills the wallet
--    exactly as before. A positive value is an allowance: each calendar month
--    the business's AI cost is charged against the allowance first and the
--    wallet only for the remainder, so «Professional with 100,000 Toman of
--    monthly AI» needs no manual grant and no second balance.
-- ---------------------------------------------------------------------------
ALTER TABLE billing_plans
    ADD COLUMN IF NOT EXISTS monthly_ai_credit_rial bigint
        CHECK (monthly_ai_credit_rial IS NULL OR monthly_ai_credit_rial >= 0);

-- ---------------------------------------------------------------------------
-- 4. Allowance consumption, one row per business per calendar month.
--
--    `used_rial` only ever grows inside the wallet transaction that settles a
--    turn (SELECT ... FOR UPDATE below it), so concurrent turns cannot spend
--    the same allowance twice. `granted_rial` snapshots the plan's allowance
--    at first use of the month — changing a plan mid-month does not rewrite
--    history, and the effective cap for the month is min(granted, current
--    plan value) resolved by the service, never by a trigger.
-- ---------------------------------------------------------------------------
CREATE TABLE ai_plan_allowance_usage (
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- Calendar month (Gregorian), e.g. '2026-09'. Deterministic, timezone-fixed
    -- to Asia/Tehran at the service boundary so a month never flips mid-turn.
    period_month    text NOT NULL CHECK (period_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
    granted_rial    bigint NOT NULL CHECK (granted_rial >= 0),
    used_rial       bigint NOT NULL DEFAULT 0 CHECK (used_rial >= 0 AND used_rial <= granted_rial),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, period_month)
);

ALTER TABLE ai_plan_allowance_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_plan_allowance_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_plan_allowance_usage FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
