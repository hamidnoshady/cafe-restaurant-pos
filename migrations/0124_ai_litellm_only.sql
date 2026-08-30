-- ============================================================================
-- 0124_ai_litellm_only.sql — Phase 39: LiteLLM-Only AI Platform (Global/Business/Branch)
--
-- 1. Merge platform_ai_config into platform_ai_gateway:
--    - Adds temperature, max_output_tokens, token costing fields to platform_ai_gateway.
--    - Backfills from platform_ai_config (enabled is kept only if provider was 'litellm').
--    - Drops platform_ai_config.
--
-- 2. Add branch layer to ai_business_gateway:
--    - Drops single-column primary key on business_id.
--    - Adds id (uuid primary key) and location_id (nullable uuid fk to locations).
--    - Adds UNIQUE NULLS NOT DISTINCT (business_id, location_id).
--
-- 3. Add location_id to ai_gateway_usage.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Merge platform_ai_config into platform_ai_gateway
-- ---------------------------------------------------------------------------
ALTER TABLE platform_ai_gateway
    ADD COLUMN IF NOT EXISTS temperature                 numeric(3,2) NOT NULL DEFAULT 0.30
        CHECK (temperature >= 0 AND temperature <= 2),
    ADD COLUMN IF NOT EXISTS max_output_tokens           integer NOT NULL DEFAULT 1000
        CHECK (max_output_tokens BETWEEN 64 AND 8192),
    ADD COLUMN IF NOT EXISTS input_cost_rial_per_million bigint NOT NULL DEFAULT 0
        CHECK (input_cost_rial_per_million >= 0),
    ADD COLUMN IF NOT EXISTS output_cost_rial_per_million bigint NOT NULL DEFAULT 0
        CHECK (output_cost_rial_per_million >= 0),
    ADD COLUMN IF NOT EXISTS revenue_margin_percent      numeric(5, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS max_turn_rial               bigint NOT NULL DEFAULT 0
        CHECK (max_turn_rial >= 0);

-- Backfill from platform_ai_config if it exists
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'platform_ai_config') THEN
        -- If platform_ai_gateway has a row, update it
        UPDATE platform_ai_gateway g
           SET temperature = c.temperature,
               max_output_tokens = c.max_output_tokens,
               input_cost_rial_per_million = c.input_cost_rial_per_million,
               output_cost_rial_per_million = c.output_cost_rial_per_million,
               revenue_margin_percent = c.revenue_margin_percent,
               max_turn_rial = c.max_turn_rial,
               enabled = CASE WHEN c.provider = 'litellm' THEN (g.enabled AND c.enabled) ELSE false END,
               chat_model = CASE WHEN c.provider = 'litellm' AND (g.chat_model IS NULL OR g.chat_model = '') THEN c.model ELSE g.chat_model END,
               base_url = CASE WHEN c.provider = 'litellm' AND c.base_url IS NOT NULL AND c.base_url <> '' THEN c.base_url ELSE g.base_url END,
               master_key = CASE WHEN c.provider = 'litellm' AND (g.master_key IS NULL OR g.master_key = '') THEN c.api_key ELSE g.master_key END
          FROM platform_ai_config c
         WHERE g.id = true AND c.id = true;

        -- If platform_ai_gateway has no row, insert one from platform_ai_config
        INSERT INTO platform_ai_gateway (
            id, enabled, base_url, master_key, chat_model, temperature, max_output_tokens,
            input_cost_rial_per_million, output_cost_rial_per_million, revenue_margin_percent, max_turn_rial
        )
        SELECT
            true,
            CASE WHEN c.provider = 'litellm' THEN c.enabled ELSE false END,
            CASE WHEN c.provider = 'litellm' AND c.base_url IS NOT NULL AND c.base_url <> '' THEN c.base_url ELSE 'http://litellm:4000/v1' END,
            CASE WHEN c.provider = 'litellm' THEN c.api_key ELSE NULL END,
            CASE WHEN c.provider = 'litellm' THEN c.model ELSE '' END,
            c.temperature,
            c.max_output_tokens,
            c.input_cost_rial_per_million,
            c.output_cost_rial_per_million,
            c.revenue_margin_percent,
            c.max_turn_rial
        FROM platform_ai_config c
        WHERE c.id = true
        ON CONFLICT (id) DO NOTHING;

        DROP TABLE platform_ai_config;
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Add branch layer to ai_business_gateway
-- ---------------------------------------------------------------------------
ALTER TABLE ai_business_gateway
    DROP CONSTRAINT IF EXISTS ai_business_gateway_pkey,
    ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES locations(id) ON DELETE CASCADE;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'ai_business_gateway_pkey'
           AND conrelid = 'ai_business_gateway'::regclass
    ) THEN
        ALTER TABLE ai_business_gateway ADD PRIMARY KEY (id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'ai_business_gateway_identity'
           AND conrelid = 'ai_business_gateway'::regclass
    ) THEN
        ALTER TABLE ai_business_gateway
            ADD CONSTRAINT ai_business_gateway_identity
                UNIQUE NULLS NOT DISTINCT (business_id, location_id);
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Add location_id to ai_gateway_usage
-- ---------------------------------------------------------------------------
ALTER TABLE ai_gateway_usage
    ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES locations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ai_gateway_usage_location_day
    ON ai_gateway_usage (location_id, day DESC);
