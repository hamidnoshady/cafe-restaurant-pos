-- Phase D (unified entity model) — the firing ledger for the Automation engine.
--
-- Migration 0155 added the automation as a noun (WHEN/IF/THEN configuration).
-- This migration adds the record of it FIRING, and — the point of the table —
-- the idempotency claim that makes firing safe on a tick that can run twice or
-- on two app instances at once.
--
-- Deliberate mirror of ai_coworker_runs (migration 0100):
--   * UNIQUE (automation_id, dedupe_key) is the whole defence against a replay
--     acting twice. A scheduled automation's key is its local business day and
--     hour; an event automation's key is the event id. The tick claims the key
--     with ON CONFLICT DO NOTHING; a second claim gets nothing and does not
--     fire. The constraint, not any read-then-write, is what makes it atomic.
--   * `status` records the outcome the same way a coworker run does, so the two
--     backgrounds surfaces read alike: 'applied' (the action ran unattended),
--     'pending_approval' (conditions held but the ceiling held the write for a
--     human), 'skipped' (conditions did not hold — nothing to do), 'failed'.
--   * `audit_id` links to the ai_action_audit row the firing produced, so an
--     applied automation shows in the SAME history as a chat, autopilot or
--     coworker write, tagged source = 'automation' (already added in 0155).
--
-- Additive: no existing row in any table is touched.

CREATE TABLE ai_automation_runs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    automation_id   uuid NOT NULL REFERENCES ai_automations(id) ON DELETE CASCADE,
    location_id     uuid REFERENCES locations(id) ON DELETE SET NULL,
    -- 'schedule' | 'event' | 'manual', the trigger that fired this run.
    trigger_source  text NOT NULL CHECK (trigger_source IN ('manual', 'schedule', 'event')),
    -- The idempotency key; see the header. UNIQUE per automation.
    dedupe_key      text NOT NULL,
    status          text NOT NULL DEFAULT 'skipped'
                        CHECK (status IN ('applied', 'pending_approval', 'skipped', 'failed')),
    -- Whether the automation's typed conditions held when it fired. A run can
    -- legitimately claim its key, evaluate to false and end 'skipped'; that is
    -- not a failure and must not alarm anyone.
    conditions_met  boolean NOT NULL DEFAULT false,
    -- The action proposed (NULL when conditions did not hold), and the audit
    -- row it produced (NULL until an action was actually proposed/applied).
    action_type     text,
    audit_id        uuid REFERENCES ai_action_audit(id) ON DELETE SET NULL,
    -- The condition facts as evaluated, compacted, for the owner to see WHY it
    -- fired (or did not) — the same compactProactiveFacts shape the coworker
    -- and autopilot runs store.
    facts           jsonb,
    summary         text,
    error           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    finished_at     timestamptz,
    CONSTRAINT ai_automation_runs_dedupe_unique UNIQUE (automation_id, dedupe_key)
);

CREATE INDEX idx_ai_automation_runs_business
    ON ai_automation_runs (business_id, created_at DESC);
CREATE INDEX idx_ai_automation_runs_automation
    ON ai_automation_runs (automation_id, created_at DESC);

ALTER TABLE ai_automation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_automation_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_automation_runs FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
