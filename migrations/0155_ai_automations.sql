-- Phase D (unified entity model) — the generic Automation engine.
--
-- The coworker (migration 0100) is a job the owner picks from a fixed set of
-- TEMPLATES: each template_key knows how to build its own actions
-- deterministically. What it cannot express is a free composition —
-- "WHEN the day closes, IF today's waste is over 500,000 ﷼, THEN draft a
-- journal note" — because a template is a whole recipe, not a trigger + a
-- condition + an action the owner assembled themselves.
--
-- This table adds that missing noun: an AUTOMATION is
--     WHEN  <trigger>            (manual | schedule | event)
--     IF    <conditions>         (a typed rule document over run-time facts)
--     THEN  <action>             (one ACTION_CATALOG action + payload template)
-- with the same ask/auto approval choice the coworker and autopilot use.
--
-- Deliberate reuse, so this is a new composition layer and not a second
-- engine:
--   * The trigger vocabulary and its shape CHECK mirror ai_coworker_jobs
--     exactly (manual/schedule/event, schedule_hour/schedule_weekday,
--     event_kind), so a later step can share one tick without a schema change.
--   * `action_type` is an ACTION_CATALOG key, validated in application code
--     against the live catalogue (minus coworker-only actions). An automation
--     therefore opens NO new mutation path: a fired automation still produces
--     the same proposal the chat would, still lands in the same approval
--     surface, still applies through the same role-guarded executor. The
--     conditions only decide WHETHER to propose.
--   * `approval_mode = 'auto'` is refused without an `authorized_by` in
--     application code, exactly as the coworker and autopilot require, so an
--     unattended write is never anonymous.
--
-- Additive: no existing agent, coworker, autopilot or proactive row is touched.

CREATE TABLE ai_automations (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- NULL = every branch, same meaning as ai_coworker_jobs.location_id.
    location_id         uuid REFERENCES locations(id) ON DELETE CASCADE,
    name                text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    trigger_kind        text NOT NULL CHECK (trigger_kind IN ('manual', 'schedule', 'event')),
    event_kind          text CHECK (event_kind IS NULL OR event_kind IN
                            ('shift_open', 'shift_close', 'day_close')),
    schedule_hour       smallint CHECK (schedule_hour IS NULL OR schedule_hour BETWEEN 0 AND 23),
    schedule_weekday    smallint CHECK (schedule_weekday IS NULL OR schedule_weekday BETWEEN 0 AND 6),
    -- The typed condition document: { all?: Condition[], any?: Condition[] }.
    -- Validated and evaluated in ai-automations.ts; an empty document always
    -- matches (the automation fires whenever its trigger does).
    conditions          jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- The action this automation proposes when its conditions hold. An
    -- ACTION_CATALOG key plus a payload template; both validated in code.
    action_type         text NOT NULL,
    action_payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
    approval_mode       text NOT NULL DEFAULT 'ask' CHECK (approval_mode IN ('ask', 'auto')),
    enabled             boolean NOT NULL DEFAULT true,
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    -- The human whose authority an unattended apply runs under; 'auto' without
    -- one is refused in application code.
    authorized_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    last_run_at         timestamptz,
    -- One name per business: the picker shows a name, so it must be unambiguous.
    CONSTRAINT ai_automations_name_unique UNIQUE (business_id, name),
    -- Each trigger kind carries exactly its own fields, mirroring
    -- ai_coworker_jobs_trigger_shape so an automation can never be half event
    -- and half schedule and fire twice.
    CONSTRAINT ai_automations_trigger_shape CHECK (
        (trigger_kind = 'event'    AND event_kind IS NOT NULL AND schedule_hour IS NULL AND schedule_weekday IS NULL)
     OR (trigger_kind = 'schedule' AND event_kind IS NULL     AND schedule_hour IS NOT NULL)
     OR (trigger_kind = 'manual'   AND event_kind IS NULL     AND schedule_hour IS NULL AND schedule_weekday IS NULL)
    )
);

CREATE INDEX idx_ai_automations_business
    ON ai_automations (business_id, enabled, trigger_kind);

ALTER TABLE ai_automations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_automations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_automations FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- 'automation' joins 'manual', 'autopilot', 'coworker' and 'agent' as the
-- fifth way an assistant write can have been authorised: an action proposed by
-- a fired automation, applied (by a human, or unattended under authority).
ALTER TABLE ai_action_audit
    DROP CONSTRAINT ai_action_audit_source_check,
    ADD CONSTRAINT ai_action_audit_source_check
        CHECK (source IN ('manual', 'autopilot', 'coworker', 'agent', 'automation'));
