-- Phase 31 — tiered AI autopilot.
--
-- Phase 18b gave the assistant a 13-action propose_action catalogue (Wave 2)
-- and a scheduled background brain (Wave 4), but the two never met: every
-- "apply" in the product is a browser fetch carrying the user's own session
-- cookie, so the tick — which has no request, no session and no cookie —
-- structurally cannot act at all. This phase lets an owner decide, in advance
-- and per category, which class of change they have already confirmed.
--
-- Three switches gate every unattended write, and all three must be on:
--   features.ai_assistant                     (the entitlement)
--   ai_proactive_settings.enabled             (the credit opt-in — unattended
--                                              provider calls spend a business's
--                                              own money, which is what that
--                                              switch has always governed)
--   ai_autopilot_settings.enabled for the action's own category
--
-- There is deliberately no master autopilot switch: "inventory on, money off"
-- is a first-class stored state, and turning one category on says nothing
-- about the others.

CREATE TABLE ai_autopilot_settings (
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    category            text NOT NULL CHECK (category IN
                            ('inventory', 'pricing', 'money', 'customer', 'waste')),
    enabled             boolean NOT NULL DEFAULT false,
    -- The caps below are the OWNER's ceiling inside a HARD ceiling enforced
    -- both here and by clampAutopilotSetting in src/lib/ai-autopilot.ts, so a
    -- mis-set number can only ever make autopilot narrower than the product
    -- allows, never wider. Meaning is per category (AUTOPILOT_CAP_MEANING):
    --   inventory: max value of one adjustment or draft PO
    --   pricing:   max absolute Rial change per item
    --   money:     max discount Rial / expense amount / journal-draft total
    --   customer, waste: no monetary effect, so NULL
    max_amount_rial     bigint CHECK (max_amount_rial IS NULL OR
                                      (max_amount_rial > 0 AND max_amount_rial <= 50000000)),
    -- pricing: max % price change. money: max discount %. Others NULL.
    max_percent         smallint CHECK (max_percent IS NULL OR
                                        (max_percent > 0 AND max_percent <= 20)),
    max_items_per_run   smallint NOT NULL DEFAULT 3
                            CHECK (max_items_per_run BETWEEN 1 AND 25),
    daily_action_limit  smallint NOT NULL DEFAULT 2
                            CHECK (daily_action_limit BETWEEN 1 AND 20),
    -- The human whose authority the unattended write runs under. Every row an
    -- executor creates is attributed to them rather than to a NULL actor, so
    -- an automated write is never anonymous and never reads as someone having
    -- typed it.
    authorized_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, category)
);

-- Per-user "I have seen autopilot activity up to here" marker, backing the
-- unread badge on the floating assistant launcher. Per user, not per business:
-- a manager clearing the badge must not hide a run from the owner.
CREATE TABLE ai_autopilot_activity_seen (
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    seen_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, user_id)
);

-- No backfill row for either table. A missing row means disabled in
-- application code (the ai_agent_settings convention), so autopilot can never
-- turn itself on for a business that existed before this migration.

-- ai_action_audit is already "every change the assistant made to this
-- business" and the hub already renders it, so autopilot history extends it
-- rather than forking into a parallel table the UI would have to merge.
ALTER TABLE ai_action_audit
    ADD COLUMN source text NOT NULL DEFAULT 'manual'
        CHECK (source IN ('manual', 'autopilot')),
    ADD COLUMN autopilot_category text
        CHECK (autopilot_category IS NULL OR autopilot_category IN
               ('inventory', 'pricing', 'money', 'customer', 'waste')),
    -- Captured by the executor AT EXECUTION TIME, inside the same transaction
    -- as the write. proposal_payload only ever holds the NEW value, so on its
    -- own it can never answer "what was the price before" — which is exactly
    -- what a one-click undo needs.
    ADD COLUMN prior_state jsonb,
    -- Why a proposal was held for a human instead of auto-applied (over a cap,
    -- category off, ...). An over-cap proposal is never dropped and never
    -- forced through: it stays 'proposed' and stays clickable.
    ADD COLUMN deferred_reason text,
    ADD COLUMN reverted_at timestamptz,
    ADD COLUMN reverted_by text,
    ADD COLUMN reversal_ref jsonb,
    DROP CONSTRAINT ai_action_audit_status_check,
    ADD CONSTRAINT ai_action_audit_status_check
        CHECK (status IN ('proposed', 'applied', 'failed', 'dismissed', 'reverted'));

CREATE INDEX idx_ai_action_audit_autopilot
    ON ai_action_audit (business_id, created_at DESC)
    WHERE source = 'autopilot';

-- A new run kind, claimed once per category per local business day, so the
-- existing UNIQUE (business_id, kind, period_key) gives autopilot its
-- idempotency for free: period_key = '<YYYY-MM-DD>:<category>'.
--
-- This also repairs 'service_reminder_drafts', which has been a live bug since
-- Phase 27 Wave 10: that wave widened ai_proactive_drafts.kind (migration
-- 0087) and started writing the new run kind from ai-proactive-service.ts, but
-- never widened ai_proactive_runs.kind — so claiming a service-reminder run
-- has always violated this CHECK. Rewriting the constraint without it would
-- re-break it, so it goes in here with the autopilot kind.
ALTER TABLE ai_proactive_runs
    DROP CONSTRAINT ai_proactive_runs_kind_check,
    ADD CONSTRAINT ai_proactive_runs_kind_check
        CHECK (kind IN ('daily_digest', 'weekly_digest', 'customer_debt_drafts',
                        'service_reminder_drafts', 'autopilot'));

ALTER TABLE ai_autopilot_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_autopilot_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_autopilot_settings FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE ai_autopilot_activity_seen ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_autopilot_activity_seen FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_autopilot_activity_seen FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
