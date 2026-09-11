-- ============================================================================
-- 0143_messaging_completion.sql — Phase 37b close-out (issues #372–#377).
--
-- Completes project-cost-centre foundations and the deterministic event queue
-- plumbing. It makes no direct provider call: event sends become campaign and
-- outbox rows, which the established messaging tick later reserves, sends and
-- posts through the engine.
-- ============================================================================

-- A message balance is the signed credit ledger, never a mutable mirror.
ALTER TABLE message_business_billing
    DROP COLUMN IF EXISTS balance_rial;

-- Phase 35 projects become operational marketing cost centres.
ALTER TABLE ai_projects
    ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'completed')),
    ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS budget_rial bigint
        CHECK (budget_rial IS NULL OR budget_rial >= 0),
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_ai_projects_business_status
    ON ai_projects (business_id, status) WHERE archived_at IS NULL;

-- A campaign can carry exactly one optional project and promotion. A missing
-- promotion means ROI is unknown, never a fabricated zero.
ALTER TABLE message_campaigns
    ADD COLUMN IF NOT EXISTS promotion_id uuid REFERENCES promotions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_message_campaigns_promotion
    ON message_campaigns (promotion_id) WHERE promotion_id IS NOT NULL;
-- A promotion selected for attribution is dedicated to this one campaign;
-- otherwise its orders cannot be honestly attributed to either campaign.
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_campaigns_dedicated_promotion
    ON message_campaigns (promotion_id) WHERE promotion_id IS NOT NULL;

-- The posting engine carries this dimension into its one-cost-document result.
ALTER TABLE journal_entries
    ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES ai_projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_journal_entries_project_date
    ON journal_entries (project_id, entry_date) WHERE project_id IS NOT NULL;

-- Lifecycle/order events use a stable key so an hourly tick or request retry
-- cannot create a second event before the coworker-runs unique key sees it.
ALTER TABLE ai_coworker_events
    ADD COLUMN IF NOT EXISTS dedupe_key text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_coworker_events_source_dedupe
    ON ai_coworker_events (business_id, kind, dedupe_key)
    WHERE dedupe_key IS NOT NULL;
ALTER TABLE ai_coworker_events
    DROP CONSTRAINT IF EXISTS ai_coworker_events_kind_check,
    ADD CONSTRAINT ai_coworker_events_kind_check CHECK (kind IN (
      'shift_open', 'shift_close', 'day_close',
      'customer_birthday', 'customer_inactive_3_months', 'order_ready'
    ));

-- Messaging is intentionally a separate capped category: customer-facing
-- automated sends must not hide in an amount-free customer category.
ALTER TABLE ai_autopilot_settings
    DROP CONSTRAINT IF EXISTS ai_autopilot_settings_category_check,
    ADD CONSTRAINT ai_autopilot_settings_category_check
      CHECK (category IN ('inventory', 'pricing', 'money', 'customer', 'waste', 'website', 'messaging'));
ALTER TABLE ai_action_audit
    DROP CONSTRAINT IF EXISTS ai_action_audit_autopilot_category_check,
    ADD CONSTRAINT ai_action_audit_autopilot_category_check
      CHECK (autopilot_category IS NULL OR autopilot_category IN
        ('inventory', 'pricing', 'money', 'customer', 'waste', 'website', 'messaging'));
