-- ============================================================================
-- 0117_ai_litellm_gateway.sql — Phase 37: an LLM gateway as a provider.
--
-- Until this migration the platform-owned AI connection (Phase 18) could only
-- ever be *one* upstream: a provider id, a base URL, a model and a key, all
-- pointing at a single vendor's OpenAI-compatible endpoint. That is exactly
-- right for a shop that buys from OpenRouter or Arvan directly, and exactly
-- wrong for a platform serving many businesses: one provider outage takes the
-- assistant, the digests, autopilot and the coworker down for every tenant at
-- once, usage has to be estimated whenever the vendor omits a usage block
-- (ai-billing.ts' `estimateTokens`), embedding support is all-or-nothing —
-- `ai-embeddings.ts` documents that OpenRouter routes chat models and not
-- embedding models, so RAG silently degrades to "off" — and the only spend
-- ceiling that exists is the one this application debits after the fact.
--
-- A gateway (LiteLLM) sits in front of many upstreams and speaks the same
-- OpenAI protocol, so it joins the very same provider catalogue rather than
-- becoming a second, parallel connection: `litellm` is now one of the three
-- values `platform_ai_config.provider` may hold. Everything the gateway adds
-- on top — virtual keys, budgets, fallbacks, model aliases, spend tracking —
-- is configuration *of that one connection*, and therefore lives beside it:
--
--   platform_ai_gateway   the deployment-wide gateway settings (a singleton,
--                         no tenant column, same exempt shape as
--                         platform_ai_config — see 0039's own comment).
--   ai_business_gateway   the per-business slice of it: the virtual key this
--                         business's calls are authenticated with, plus the
--                         budget/rate ceilings and model choice attached to
--                         that key. Tenant-scoped, RLS forced, so it is
--                         covered by the Phase 17 generated isolation test
--                         without being hand-added to any list.
--
-- Money stays where it always was. The gateway's budgets are USD and are a
-- *safety net enforced by the gateway*; the integer-Rial credit ledger in
-- `ai_business_billing` remains the only thing a business is billed against
-- and the only thing its dashboard shows. Nothing below moves money out of
-- Rial, and no business-facing response ever carries the master key.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. `litellm` joins the provider catalogue.
--
-- The 0039 column CHECK is dropped by name discovery rather than by guessing
-- the name Postgres generated, so this file applies on a database whose
-- constraint ended up named differently (a restored dump, a renamed table).
-- The new constraint gets a distinct name and is excluded from the sweep, so
-- re-running this block is inert.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    constraint_name text;
BEGIN
    FOR constraint_name IN
        SELECT con.conname
          FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
         WHERE rel.relname = 'platform_ai_config'
           AND con.contype = 'c'
           AND con.conname <> 'platform_ai_config_provider_check_v2'
           AND pg_get_constraintdef(con.oid) LIKE '%provider%'
    LOOP
        EXECUTE format(
            'ALTER TABLE platform_ai_config DROP CONSTRAINT %I',
            constraint_name
        );
    END LOOP;
END $$;

ALTER TABLE platform_ai_config
    ADD CONSTRAINT platform_ai_config_provider_check_v2
        CHECK (provider IN ('openrouter', 'arvan', 'litellm'));

-- ---------------------------------------------------------------------------
-- 2. The deployment-wide gateway settings.
--
-- Global catalogue/configuration table, deliberately with no RLS and no tenant
-- column, supervised only by the platform-admin realm: it holds the gateway's
-- master key, and rotating it is a deployment-wide act by definition. This is
-- the same exemption, for the same reason, as platform_ai_config itself.
-- ---------------------------------------------------------------------------
CREATE TABLE platform_ai_gateway (
    id                      boolean PRIMARY KEY DEFAULT true CHECK (id),
    enabled                 boolean NOT NULL DEFAULT false,

    -- The gateway's own OpenAI-compatible base URL, e.g.
    -- http://litellm:4000/v1 on the compose network.
    --
    -- Read as: the address for the MANAGEMENT api (/key/*, /model/info,
    -- /health), which is only one level up from the provider's /v1 endpoint.
    -- It is a fallback, not a second source of truth: while the provider is
    -- `litellm`, `platform_ai_config.base_url` IS the gateway's address and
    -- wins (see `resolveGatewayBaseUrl`), because two stored addresses would
    -- only ever drift apart — chat on one host, key minting on another. It
    -- is consulted only when the provider is something else, so the gateway's
    -- features can be configured before the connection is switched over.
    base_url                text NOT NULL DEFAULT 'http://litellm:4000/v1',

    -- The proxy admin key. Used only for /key/* management calls and for
    -- tenant calls that have no virtual key yet; never leaves the server and
    -- is never rendered, only acknowledged as present.
    master_key              text,

    -- Model *aliases* as the gateway defines them (pos-chat, pos-embed …).
    -- Blank means "keep using platform_ai_config.model", which is what every
    -- existing deployment is already doing.
    chat_model              text NOT NULL DEFAULT '',
    embedding_model         text NOT NULL DEFAULT '',

    -- Failover chain, consulted in order after the primary model errors out.
    -- Sent per request as LiteLLM's client-side `fallbacks` parameter, so the
    -- chain is editable here without a gateway restart or a config file edit.
    fallback_models         jsonb NOT NULL DEFAULT '[]'::jsonb
                                CHECK (jsonb_typeof(fallback_models) = 'array'),

    -- Which deployment of a model group the gateway picks when several share
    -- one alias. Constrained to the strategies the proxy actually implements;
    -- an unrecognised value would otherwise be a silent no-op.
    routing_strategy        text NOT NULL DEFAULT 'simple-shuffle'
                                CHECK (routing_strategy IN (
                                    'simple-shuffle',
                                    'least-busy',
                                    'usage-based-router',
                                    'latency-based-routing',
                                    'cost-based-routing'
                                )),

    -- Provision one LiteLLM virtual key per business and authenticate that
    -- business's calls with it. This is what makes per-tenant spend, budgets
    -- and rate limits exist inside the gateway at all: without a per-key
    -- identity every tenant shares the master key's single spend counter.
    virtual_keys_enabled    boolean NOT NULL DEFAULT false,

    -- Whether a business may pick its own model, and from what. Off by
    -- default: an open model picker is an open invoice — the platform pays
    -- the upstream bill and bills the business afterwards, so the choice has
    -- to be one the platform has priced.
    allow_business_models   boolean NOT NULL DEFAULT false,
    published_models        jsonb NOT NULL DEFAULT '[]'::jsonb
                                CHECK (jsonb_typeof(published_models) = 'array'),

    -- Defaults stamped onto every newly provisioned virtual key. LiteLLM
    -- budgets are USD, which is precisely why they are only a backstop: the
    -- authoritative ceiling stays the Rial credit balance in
    -- ai_business_billing. NULL means "no gateway-side limit".
    default_max_budget_usd  numeric(14, 6)
                                CHECK (default_max_budget_usd IS NULL
                                       OR default_max_budget_usd > 0),
    -- A LiteLLM budget window is passed to the gateway verbatim, so its
    -- grammar is checked here as well as in the application: digits plus one
    -- of the units the proxy understands. An arbitrary string would be a
    -- rejected write at best and a nonsensical budget window at worst.
    default_budget_duration text NOT NULL DEFAULT '30d'
                                CHECK (default_budget_duration ~ '^\d+\s*(s|m|h|d|mo)$'),
    default_tpm_limit       integer
                                CHECK (default_tpm_limit IS NULL OR default_tpm_limit > 0),
    default_rpm_limit       integer
                                CHECK (default_rpm_limit IS NULL OR default_rpm_limit > 0),

    updated_at              timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 3. The per-business slice.
--
-- One optional row per business. Absent is a meaningful state, not a missing
-- one: with virtual keys off, or before an admin has provisioned this
-- business's key, there is nothing to store and the shared connection is used.
-- The RLS below is therefore the reason this is a side table rather than four
-- more nullable columns on ai_business_billing — a row here exists only for
-- businesses the gateway actually fronts, and isolation is enforced on it.
-- ---------------------------------------------------------------------------
CREATE TABLE ai_business_gateway (
    business_id     uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,

    -- The virtual key this business's provider calls authenticate with. A
    -- spend-scoped gateway credential, not an upstream vendor key: its worst
    -- case is that one business exhausts its own gateway budget, which the
    -- Rial credit ceiling has already bounded. Stored in the clear for the
    -- same reason platform_ai_config.api_key is — the server must send it.
    virtual_key     text,
    key_alias       text,

    -- This business's model choice, when the platform allows one. NULL means
    -- "whatever the platform configured"; the value is validated against
    -- platform_ai_gateway.published_models on the way in, so it cannot be
    -- used to reach a model the platform has not priced.
    model_override  text,

    max_budget_usd  numeric(14, 6)
                        CHECK (max_budget_usd IS NULL OR max_budget_usd > 0),
    budget_duration text
                        CHECK (budget_duration IS NULL
                               OR budget_duration ~ '^\d+\s*(s|m|h|d|mo)$'),
    tpm_limit       integer CHECK (tpm_limit IS NULL OR tpm_limit > 0),
    rpm_limit       integer CHECK (rpm_limit IS NULL OR rpm_limit > 0),

    -- Last spend the gateway reported for this key, USD. A diagnostic to
    -- reconcile against the Rial ledger, never a billing source.
    spend_usd       numeric(14, 6) NOT NULL DEFAULT 0
                        CHECK (spend_usd >= 0),

    synced_at       timestamptz,
    sync_error      text,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ai_business_gateway ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_business_gateway FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_business_gateway FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
