-- ============================================================================
-- 0123_ai_litellm_platform.sql — Phase 38b: the gateway stops being only a
-- route and becomes the platform's costing, usage, prompt and MCP layer.
--
-- Phase 37 put LiteLLM in front of the vendors and gave every business a
-- virtual key. What it deliberately did NOT do was take money figures from
-- the gateway: spend was a diagnostic, usage was estimated, prompts lived
-- only in this database, and the proxy's MCP hub was not wired to anything.
-- This migration completes that move, one column group per capability:
--
--   * **Costing.** LiteLLM prices every request from its own model-cost map
--     and reports it per response (`x-litellm-response-cost`, USD) and per
--     key (`/key/info`). With `gateway_costing_enabled` the platform adopts
--     that figure as the real cost behind the Rial ledger, converted by
--     `usd_rial_rate`; the manual per-million token rates remain the
--     fallback and stay authoritative while the switch is off. Nothing
--     moves out of integer Rial — the USD figure never reaches a balance.
--   * **Usage.** The proxy accumulates one spend log per request
--     (`/spend/logs`), carrying the calling key's alias, the model that
--     actually served the call, tokens and USD cost. `ai_gateway_usage`
--     stores the app-side daily rollup of those logs so the console and the
--     business's own settings can show usage without querying the gateway
--     on every page view.
--   * **Prompt management (skills).** A surface → prompt_id map points each
--     agent surface at a prompt kept in the gateway's prompt registry
--     (dotprompt files on disk, or any supported prompt integration). The
--     app stops sending its own system message for a bound surface and sends
--     `prompt_id` + `prompt_variables` instead, so prompt engineering
--     becomes a gateway-side, restart-free edit.
--   * **MCP / agentic.** An explicit server list lets the proxy front MCP
--     servers — including this application's own /api/mcp connector — and
--     auto-execute their tools inside a chat completion
--     (`tools: [{type: "mcp", server_url: "litellm_proxy/<name>/mcp", …}]`),
--     which is what makes the assistant agentic beyond its own read tools.
--
-- Money, as always, stays in `ai_business_billing`. Every USD column below
-- is a diagnostic or a conversion input, never a balance.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The gateway gains its platform-side capabilities.
-- ---------------------------------------------------------------------------
ALTER TABLE platform_ai_gateway
    ADD COLUMN usd_rial_rate            numeric(14, 2)
        CHECK (usd_rial_rate IS NULL OR usd_rial_rate > 0),
    ADD COLUMN gateway_costing_enabled  boolean NOT NULL DEFAULT false,
    ADD COLUMN prompt_bindings          jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(prompt_bindings) = 'object'),
    ADD COLUMN mcp_enabled              boolean NOT NULL DEFAULT false,
    ADD COLUMN mcp_servers              jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(mcp_servers) = 'array');

COMMENT ON COLUMN platform_ai_gateway.usd_rial_rate IS
    'FX rate converting the gateway''s USD cost figures into integer Rial; required for gateway costing.';
COMMENT ON COLUMN platform_ai_gateway.gateway_costing_enabled IS
    'When on, a turn''s cost comes from the gateway''s reported USD cost times usd_rial_rate (margin on top); the manual token rates remain the fallback.';
COMMENT ON COLUMN platform_ai_gateway.prompt_bindings IS
    'Object mapping an agent surface (wizard/dashboard/floor/proactive/autopilot/platform) to a LiteLLM prompt_id.';
COMMENT ON COLUMN platform_ai_gateway.mcp_servers IS
    'Array of {name, label, url, requireApproval} MCP servers the proxy may front; safe only when mcp_enabled.';

-- ---------------------------------------------------------------------------
-- 2. The app-side daily rollup of the gateway's spend logs.
--
-- One row per (day, key alias, model). `business_id` is resolved from the
-- virtual-key alias at sync time and is nullable on purpose: the master key
-- and any manual key have no alias→business mapping, and a deleted business
-- keeps its historical usage. Tenant-scoped, RLS forced, so a business can
-- read only its own rows from its settings page while the console reads
-- through the documented platform bypass.
-- ---------------------------------------------------------------------------
CREATE TABLE ai_gateway_usage (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    day               date NOT NULL,
    key_alias         text NOT NULL,
    business_id       uuid REFERENCES businesses(id) ON DELETE SET NULL,
    model             text NOT NULL,
    spend_usd         numeric(14, 6) NOT NULL DEFAULT 0 CHECK (spend_usd >= 0),
    prompt_tokens     bigint NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
    completion_tokens bigint NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
    api_requests      integer NOT NULL DEFAULT 0 CHECK (api_requests >= 0),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT ai_gateway_usage_identity UNIQUE (day, key_alias, model)
);

CREATE INDEX ai_gateway_usage_business_day_idx
    ON ai_gateway_usage (business_id, day DESC);
CREATE INDEX ai_gateway_usage_day_idx ON ai_gateway_usage (day DESC);

ALTER TABLE ai_gateway_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_gateway_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_gateway_usage FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
