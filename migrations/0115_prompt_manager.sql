-- ============================================================================
-- 0115_prompt_manager.sql — the two-layer prompt manager.
--
-- Layer 1 (platform) already exists: ai_prompt_templates (migration 0112)
-- holds platform-wide fragment overrides; an active row for `surface:<mode>`
-- replaces the code-built system prompt for that surface entirely. Superadmin
-- owns that table and with it every surface the assistant answers on.
--
-- Layer 2 (business) is this migration: `ai_prompt_overrides`. A business
-- manager cannot replace the platform prompt — the confirm-before-write rules
-- and the tool contract live there — but they can append standing
-- instructions for their own assistant on the surfaces they use
-- (dashboard / floor / wizard), exactly like a project's standing
-- instruction, but per surface and always on.
--
-- One active override per (business, surface), enforced by a partial unique
-- index, same shape as 0112's single-active-version contract.
-- ============================================================================

CREATE TABLE ai_prompt_overrides (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- The assistant surface this shapes. The API layer enforces the allowed
    -- list (dashboard / floor / wizard); the CHECK here is the floor under it.
    surface      text NOT NULL CHECK (surface IN ('dashboard', 'floor', 'wizard')),
    instructions text NOT NULL CHECK (btrim(instructions) <> ''),
    is_active    boolean NOT NULL DEFAULT true,
    updated_by   text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- One active instruction block per business + surface.
CREATE UNIQUE INDEX idx_ai_prompt_overrides_active
    ON ai_prompt_overrides (business_id, surface)
    WHERE is_active = true;

CREATE INDEX idx_ai_prompt_overrides_business
    ON ai_prompt_overrides (business_id, updated_at DESC);

ALTER TABLE ai_prompt_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_prompt_overrides FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_prompt_overrides FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
