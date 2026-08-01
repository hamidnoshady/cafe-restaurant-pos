-- Phase 18b Wave 5 — durable audit trail for human-confirmed AI proposals.
-- The proposal is created inside the tenant-scoped chat route. Final status is
-- written only after the existing role-guarded endpoint has responded; no AI
-- proposal creates a new direct-write path.

CREATE TABLE ai_action_audit (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    actor_user_id       text NOT NULL,
    actor_name          text NOT NULL DEFAULT '',
    prompt_excerpt      text NOT NULL,
    action_type         text NOT NULL,
    action_title        text NOT NULL,
    action_summary      text NOT NULL DEFAULT '',
    proposal_payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
    status              text NOT NULL DEFAULT 'proposed'
                            CHECK (status IN ('proposed', 'applied', 'failed', 'dismissed')),
    result              jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),
    applied_at          timestamptz
);

CREATE INDEX idx_ai_action_audit_business_created
    ON ai_action_audit (business_id, created_at DESC);
CREATE INDEX idx_ai_action_audit_business_status
    ON ai_action_audit (business_id, status, created_at DESC);

ALTER TABLE ai_action_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_action_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_action_audit FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
