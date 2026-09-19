-- Phase D (unified entity model) — custom Agents.
--
-- Until now an "agent" was one of five hard-coded keys (`ai_agent_settings`,
-- migration 0047) that a business could only turn on/off and reschedule. There
-- was no way for an owner to say "I want an assistant that only reads my
-- inventory and only ever proposes reorder POs, and here is how I want it to
-- talk". This table adds that noun: a business-defined agent with its own
-- name, its own instructions (a per-agent system-prompt fragment), and two
-- allowlists that NARROW — never widen — what a chat turn run "as" this agent
-- can see and do.
--
-- Two deliberate safety properties, enforced in application code
-- (`ai-custom-agents.ts`) and mirrored here where a CHECK can carry them:
--   * The tool allowlist is validated against the real dashboard read-tool set
--     and the action allowlist against ACTION_CATALOG (minus coworker-only
--     actions), so an agent can only pick from tools/actions that already
--     exist and are already role-guarded. An empty action allowlist means the
--     agent proposes nothing — a pure read agent.
--   * An agent adds NO new mutation path. A turn run as an agent still emits
--     `propose_action`, still lands in the same confirm loop, still applies
--     through the same role-guarded route with the user's own session. The
--     agent only decides which subset of the catalogue the model may name.
--
-- This is additive: no existing agent, coworker, autopilot or proactive row is
-- touched, and a business with no custom agent behaves exactly as before.

CREATE TABLE ai_custom_agents (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name                text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    -- The per-agent system-prompt fragment. Appended to the code-built
    -- dashboard prompt, never replacing it: the grounding rules (Persian,
    -- Toman, Jalali, "never invent a number") always stand.
    instructions        text NOT NULL DEFAULT '' CHECK (char_length(instructions) <= 4000),
    -- The read tools this agent may call. A subset of the dashboard read-tool
    -- names; validated in application code against the live set so a renamed
    -- or removed tool cannot linger here. Empty = no read tools.
    tool_allowlist      text[] NOT NULL DEFAULT '{}'::text[],
    -- The action types this agent may propose. A subset of ACTION_CATALOG's
    -- keys minus the coworker-only ones. Empty = a read-only agent that
    -- proposes nothing.
    action_allowlist    text[] NOT NULL DEFAULT '{}'::text[],
    enabled             boolean NOT NULL DEFAULT true,
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    -- Two agents with the same name in one business is a naming mistake, not a
    -- second agent; the picker shows a name, so it must be unambiguous.
    CONSTRAINT ai_custom_agents_name_unique UNIQUE (business_id, name)
);

CREATE INDEX idx_ai_custom_agents_business
    ON ai_custom_agents (business_id, enabled, created_at DESC);

ALTER TABLE ai_custom_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_custom_agents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_custom_agents FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- 'agent' joins 'manual', 'autopilot' and 'coworker' as a fourth way an
-- assistant write can have been authorised: a proposal produced by a turn run
-- as a custom agent, still applied by a human's click.
ALTER TABLE ai_action_audit
    DROP CONSTRAINT ai_action_audit_source_check,
    ADD CONSTRAINT ai_action_audit_source_check
        CHECK (source IN ('manual', 'autopilot', 'coworker', 'agent'));
