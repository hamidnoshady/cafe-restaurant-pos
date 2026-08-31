-- ============================================================================
-- 0125_ai_litellm_routing.sql — align platform_ai_gateway.routing_strategy with
-- the routing strategies the LiteLLM proxy actually implements.
--
-- 0121 constrained the column to five values, one of which ('usage-based-router')
-- has never been a LiteLLM strategy. The proxy ignores an unrecognised
-- routing_strategy without raising, so a row holding that value looked
-- configured and did nothing at all.
--
-- The proxy's real vocabulary (litellm's `RoutingStrategy` enum, plus
-- `simple-shuffle` which is the default and is offered alongside it):
--
--   simple-shuffle            weighted random pick; the documented production
--                             default, and the only strategy under which the
--                             router's weighted in-group failover applies
--   least-busy                fewest in-flight requests
--   latency-based-routing     lowest measured latency in a sliding window
--   cost-based-routing        lowest cost per token (async)
--   usage-based-routing-v2    lowest TPM usage, tracked asynchronously
--   usage-based-routing       the deprecated v1 of the above
--   provider-budget-routing   routes within a provider's remaining budget
--
-- This value is a proxy-side setting: it lives in `router_settings` of the
-- gateway's config.yaml, and LiteLLM exposes no endpoint that changes it at
-- runtime (`GET /router/settings` is read-only). The column therefore records
-- which strategy this deployment is expected to run, and the console verifies
-- it against the proxy's own report instead of pretending to push it.
-- ============================================================================

-- Fold the value the old constraint allowed onto its real successor before the
-- new constraint lands, so no existing row can fail it.
UPDATE platform_ai_gateway
   SET routing_strategy = 'usage-based-routing-v2',
       updated_at       = now()
 WHERE routing_strategy = 'usage-based-router';

ALTER TABLE platform_ai_gateway
    DROP CONSTRAINT IF EXISTS platform_ai_gateway_routing_strategy_check;

ALTER TABLE platform_ai_gateway
    ADD CONSTRAINT platform_ai_gateway_routing_strategy_check
        CHECK (routing_strategy IN (
            'simple-shuffle',
            'least-busy',
            'latency-based-routing',
            'cost-based-routing',
            'usage-based-routing-v2',
            'usage-based-routing',
            'provider-budget-routing'
        ));
