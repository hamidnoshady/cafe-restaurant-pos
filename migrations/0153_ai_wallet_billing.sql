-- ============================================================================
-- 0153_ai_wallet_billing.sql — AI Operating Layer, Phase B (billing cutover).
--
-- Until now AI spend was billed against a SECOND money balance
-- (`ai_business_billing.balance_rial` + `ai_credit_ledger`) using a
-- reserve→settle→cancel dance (`reserveAiTurn`/`settleAiTurn`/
-- `cancelAiTurnReservation`): every turn debited the configured *maximum*
-- turn amount up front and refunded the remainder afterwards. That is the
-- "reserve the maximum turn" anti-pattern the rebuild retires.
--
-- The canonical `business_wallets` / `wallet_ledger` (migration 0130) becomes
-- the ONLY tenant monetary balance. AI turns now:
--   1. gate on the real wallet balance BEFORE the request (affordability),
--   2. run,
--   3. settle the REAL cost (LiteLLM's reported USD → Rial, plus optional
--      platform margin; token-rate fallback when the gateway didn't price it)
--      as a normal `wallet_ledger` debit with `feature_key = 'ai'`.
--
-- This migration is ADDITIVE. It does NOT drop `ai_business_billing` or
-- `ai_credit_ledger`; those stay readable for reconciliation and are removed
-- in a later, separate destructive migration once the cutover is proven in
-- production (rebuild Part 34: never drop a table in the same step that
-- introduces its replacement).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The `ai` feature key.
--
-- `wallet_ledger.feature_key` is an FK to `feature_flags(key)`; the canonical
-- AI debit therefore needs an `ai` row to point at. It is default-ON: a
-- business that already has the (default-OFF, entitlement) `ai_assistant`
-- feature is billed under `ai`, but `ai` itself is a billing/catalogue key,
-- not an entitlement gate — entitlement stays `ai_assistant` (see
-- src/lib/features.ts). Keeping them separate means turning AI billing on for
-- reporting never accidentally grants access.
-- ---------------------------------------------------------------------------
INSERT INTO feature_flags (key, name, description, default_enabled) VALUES
    ('ai', 'هوش مصنوعی', 'هزینهٔ استفاده از سرویس هوش مصنوعی از کیف پول کسب‌وکار', true)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. AI settlement metadata (observability + idempotency).
--
-- The wallet ledger holds the canonical Rial debit; this table holds the AI
-- detail behind it so support and billing disputes can correlate one turn end
-- to end (rebuild Part 38) WITHOUT bloating `wallet_ledger.metadata` or
-- forcing every AI query to scan the whole ledger.
--
-- Idempotency: at most one settlement per (business, request_id). A retried
-- callback or a double-settle attempt hits the unique index and is a no-op,
-- so a turn is never charged twice — the wallet-side guarantee the old
-- reservation ledger enforced with `idx_ai_credit_ledger_one_usage_reservation`.
--
-- Money never lives here: `charged_rial` is a mirror of the wallet debit for
-- convenience; the wallet is the source of truth. `cost_usd` is the gateway's
-- own diagnostic figure and never reaches a balance.
-- ---------------------------------------------------------------------------
CREATE TABLE ai_wallet_settlements (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- The application's own per-turn identity, generated before the request so
    -- a settlement can be found even if the gateway never returned a call id.
    request_id          uuid NOT NULL,
    -- LiteLLM's own request/call id (x-litellm-call-id) when the turn went
    -- through the gateway; null for a direct-vendor or cached turn.
    litellm_call_id     text,
    -- Where this turn originated, so usage can be sliced by surface/entity.
    request_type        text NOT NULL DEFAULT 'chat'
                            CHECK (request_type IN (
                                'chat', 'vision', 'ocr', 'media_detect',
                                'proactive', 'autopilot', 'coworker', 'agent',
                                'automation', 'embedding', 'other'
                            )),
    model               text,
    -- Optional correlation ids (rebuild Part 38). Kept as loose uuids rather
    -- than FKs so a settlement survives the deletion of the thing it billed.
    conversation_id     uuid,
    project_id          uuid,
    agent_id            uuid,
    automation_id       uuid,
    coworker_id         uuid,
    location_id         uuid,
    -- Token accounting where the provider reported it.
    input_tokens        integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
    output_tokens       integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
    cache_hit           boolean NOT NULL DEFAULT false,
    -- Cost breakdown. cost_usd = gateway figure; provider_cost_rial = its Rial
    -- conversion (platform's real cost); charged_rial = what the wallet was
    -- actually debited (provider cost + margin, clamped to available balance).
    cost_usd            numeric(12, 6) CHECK (cost_usd IS NULL OR cost_usd >= 0),
    provider_cost_rial  bigint NOT NULL DEFAULT 0 CHECK (provider_cost_rial >= 0),
    charged_rial        bigint NOT NULL DEFAULT 0 CHECK (charged_rial >= 0),
    -- The shortfall when the settled cost could not be fully covered by the
    -- wallet (post-hoc overage after a genuine provider cost was incurred).
    -- Never hidden: it is surfaced and the next turn's gate blocks on it.
    debt_rial           bigint NOT NULL DEFAULT 0 CHECK (debt_rial >= 0),
    priced_by           text NOT NULL DEFAULT 'token_rate'
                            CHECK (priced_by IN ('gateway', 'token_rate', 'free')),
    -- The wallet_ledger row this settlement produced (null for a zero-cost /
    -- fully-free turn that never wrote a debit).
    wallet_ledger_id    uuid REFERENCES wallet_ledger(id) ON DELETE SET NULL,
    created_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
    metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now()
);

-- One settlement per (business, request). The partial-free-of duplicate guard.
CREATE UNIQUE INDEX idx_ai_wallet_settlements_request
    ON ai_wallet_settlements (business_id, request_id);
-- Usage slicing (Part 32): recent settlements per business, and by entity.
CREATE INDEX idx_ai_wallet_settlements_business_created
    ON ai_wallet_settlements (business_id, created_at DESC);
CREATE INDEX idx_ai_wallet_settlements_project
    ON ai_wallet_settlements (business_id, project_id, created_at DESC)
    WHERE project_id IS NOT NULL;

-- Same forced-RLS tenant policy every business-owned table uses (0039/0130).
ALTER TABLE ai_wallet_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_wallet_settlements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_wallet_settlements FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 3. Outstanding AI debt per business (the affordability backstop).
--
-- A single running total per business of AI cost incurred but not yet covered
-- by the wallet. It is the deterministic thing the pre-request gate consults:
-- a business with debt cannot start another AI turn until it tops up (which
-- clears the debt first). Kept out of `business_wallets` so the wallet's
-- balance column stays a pure, never-negative Rial balance.
-- ---------------------------------------------------------------------------
CREATE TABLE ai_wallet_debt (
    business_id     uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
    debt_rial       bigint NOT NULL DEFAULT 0 CHECK (debt_rial >= 0),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ai_wallet_debt ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_wallet_debt FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_wallet_debt FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- `wallet_ledger.kind` already includes 'feature_charge', which is the kind
-- an AI debit uses (feature_key = 'ai'). No new ledger kind is required, so a
-- business's existing billing page shows AI spend beside every other feature
-- charge with no schema change to that table.
