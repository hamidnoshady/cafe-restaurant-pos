-- Phase 27 Wave 10 — proactive service-reminder drafts ride the same job
-- runner as debt follow-ups, so ai_proactive_drafts must accept a second
-- shape: a shop-facing nudge with no customer and no amount, deduped per day
-- by the serial it refers to.
--
-- The two debt-only constraints are relaxed (not dropped): customer_id and
-- amount_rial become nullable, and the kind CHECK admits 'service_reminder'.
-- The existing (business_id, kind, customer_id, period_key) UNIQUE is left
-- alone — NULL customer_ids never collide, so debt rows keep their
-- idempotency and service rows are deduped by a new partial index instead.

ALTER TABLE ai_proactive_drafts
    DROP CONSTRAINT ai_proactive_drafts_kind_check,
    ADD CONSTRAINT ai_proactive_drafts_kind_check
        CHECK (kind IN ('customer_debt_follow_up', 'service_reminder')),
    ALTER COLUMN customer_id DROP NOT NULL,
    ALTER COLUMN amount_rial DROP NOT NULL,
    DROP CONSTRAINT ai_proactive_drafts_amount_rial_check,
    ADD CONSTRAINT ai_proactive_drafts_amount_rial_check
        CHECK (amount_rial IS NULL OR amount_rial > 0),
    -- The serial (item_serials.id) a service reminder points at, so the same
    -- unit is not nudged twice in one day.
    ADD COLUMN source_ref text;

CREATE UNIQUE INDEX uq_ai_proactive_drafts_service_reminder
    ON ai_proactive_drafts (business_id, period_key, source_ref)
    WHERE kind = 'service_reminder';
