-- Phase 32 — the AI coworker («همکار هوشمند»).
--
-- Phase 18b gave the assistant a confirm-gated action catalogue and Phase 31
-- let a *category* of proposal apply itself unattended, but both share one
-- shape: the model looks at the business, decides on its own what is worth
-- doing, and does (or offers) it. An owner who already knows the job — "every
-- night when the shift closes, write off the bread that is left" — had nowhere
-- to put that sentence. They could only wait and hope the model proposed it.
--
-- This phase adds the missing noun: a JOB the owner defines once, that fires
-- on a trigger, builds its actions DETERMINISTICALLY from a template, and
-- lands in an approval inbox unless the owner said in advance not to ask.
--
-- Three deliberate consequences of "deterministically":
--   * A run costs no AI credits and needs no provider. The model is how a job
--     is *set up* and *talked about*; it is not in the loop when one fires.
--     Accounting work that repeats every night must not depend on a sampled
--     token, and must produce the identical actions from identical facts.
--   * A job is gated on the `ai_assistant` entitlement only — not on
--     ai_proactive_settings.enabled, which is the *credit* opt-in.
--   * Every quantity a run acts on is read from the database at fire time,
--     never carried in the job's stored params (which hold the owner's intent
--     — which item, which reason — not a number that has since moved).
--
-- Applying an approved action reuses Phase 31's executors unchanged, so this
-- phase opens no new mutation path: the same service function the route
-- handler calls, inside the same tenant scope, with the same audit row.

CREATE TABLE ai_coworker_jobs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- NULL = every branch. A job that names a branch fires only for that one,
    -- which is what "the bread at the Vanak store" means.
    location_id         uuid REFERENCES locations(id) ON DELETE CASCADE,
    template_key        text NOT NULL,
    title               text NOT NULL,
    trigger_kind        text NOT NULL CHECK (trigger_kind IN ('manual', 'schedule', 'event')),
    -- Business events, not clock times: "after the shift closes" is a fact the
    -- shift table knows and a cron expression can only approximate.
    event_kind          text CHECK (event_kind IS NULL OR event_kind IN
                            ('shift_open', 'shift_close', 'day_close')),
    schedule_hour       smallint CHECK (schedule_hour IS NULL OR schedule_hour BETWEEN 0 AND 23),
    -- NULL on a daily schedule; 0..6 (Saturday..Friday) pins it to one weekday.
    schedule_weekday    smallint CHECK (schedule_weekday IS NULL OR schedule_weekday BETWEEN 0 AND 6),
    -- The owner's INTENT (which item, which reason, which formula) — never a
    -- quantity that the database is the authority on.
    params              jsonb NOT NULL DEFAULT '{}'::jsonb,
    approval_mode       text NOT NULL DEFAULT 'ask' CHECK (approval_mode IN ('ask', 'auto')),
    enabled             boolean NOT NULL DEFAULT true,
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    -- The human whose authority an unattended apply runs under, exactly as
    -- ai_autopilot_settings.authorized_by does. 'auto' without one is refused
    -- in application code, so an automated write is never anonymous.
    authorized_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    last_run_at         timestamptz,
    -- Each trigger kind carries exactly its own fields, so a job can never be
    -- half event and half schedule and fire twice.
    CONSTRAINT ai_coworker_jobs_trigger_shape CHECK (
        (trigger_kind = 'event'    AND event_kind IS NOT NULL AND schedule_hour IS NULL AND schedule_weekday IS NULL)
     OR (trigger_kind = 'schedule' AND event_kind IS NULL     AND schedule_hour IS NOT NULL)
     OR (trigger_kind = 'manual'   AND event_kind IS NULL     AND schedule_hour IS NULL AND schedule_weekday IS NULL)
    )
);

CREATE INDEX idx_ai_coworker_jobs_business ON ai_coworker_jobs (business_id, enabled, trigger_kind);

-- The event queue. The shift service enqueues; the tick consumes. Decoupled on
-- purpose: closing a shift is a cashier's foreground request and must never
-- wait on — or fail because of — a coworker job, so the write is one INSERT
-- and everything else happens later.
CREATE TABLE ai_coworker_events (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id     uuid REFERENCES locations(id) ON DELETE SET NULL,
    kind            text NOT NULL CHECK (kind IN ('shift_open', 'shift_close', 'day_close')),
    occurred_at     timestamptz NOT NULL DEFAULT now(),
    -- The branch's own business day (app_business_date), resolved by the
    -- enqueuer. A café closing at 03:00 keeps the night it belongs to.
    business_date   date,
    payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
    processed_at    timestamptz
);

CREATE INDEX idx_ai_coworker_events_pending
    ON ai_coworker_events (business_id, occurred_at)
    WHERE processed_at IS NULL;

-- One firing of one job.
CREATE TABLE ai_coworker_runs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    job_id          uuid NOT NULL REFERENCES ai_coworker_jobs(id) ON DELETE CASCADE,
    location_id     uuid REFERENCES locations(id) ON DELETE SET NULL,
    trigger_source  text NOT NULL CHECK (trigger_source IN ('manual', 'schedule', 'event')),
    -- Idempotency: '<event id>' for an event, '<YYYY-MM-DD>:<hour>' for a
    -- schedule, '<ISO instant>' for a manual run. The UNIQUE below is what
    -- makes a tick that runs twice — or two app instances ticking at once —
    -- produce one run rather than two write-ups of the same night.
    dedupe_key      text NOT NULL,
    status          text NOT NULL CHECK (status IN
                        ('pending_approval', 'applied', 'partially_applied',
                         'rejected', 'failed', 'skipped', 'reported')),
    summary         text NOT NULL DEFAULT '',
    -- The database values the actions were built from, captured at fire time,
    -- so an approval three hours later can be read against what was true then.
    facts           jsonb NOT NULL DEFAULT '{}'::jsonb,
    error           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    decided_at      timestamptz,
    decided_by      text,
    UNIQUE (job_id, dedupe_key)
);

CREATE INDEX idx_ai_coworker_runs_business_created
    ON ai_coworker_runs (business_id, created_at DESC);
CREATE INDEX idx_ai_coworker_runs_pending
    ON ai_coworker_runs (business_id, created_at DESC)
    WHERE status = 'pending_approval';

-- The actions a run wants to take. One row per action so a run can be approved
-- whole while still recording that line 3 of 5 failed — a night's write-off is
-- five items, and "the whole run failed" would be a lie about the other four.
CREATE TABLE ai_coworker_run_actions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    run_id          uuid NOT NULL REFERENCES ai_coworker_runs(id) ON DELETE CASCADE,
    seq             smallint NOT NULL,
    action_type     text NOT NULL,
    title           text NOT NULL,
    summary         text NOT NULL DEFAULT '',
    payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
    status          text NOT NULL DEFAULT 'pending' CHECK (status IN
                        ('pending', 'applied', 'failed', 'rejected', 'skipped')),
    -- The ai_action_audit row the apply wrote. The hub's audit tab is still
    -- "every change the assistant made", so a coworker apply extends it rather
    -- than forking a parallel history.
    audit_id        uuid REFERENCES ai_action_audit(id) ON DELETE SET NULL,
    result          jsonb,
    error           text,
    applied_at      timestamptz,
    UNIQUE (run_id, seq)
);

CREATE INDEX idx_ai_coworker_run_actions_run ON ai_coworker_run_actions (run_id, seq);

-- 'coworker' joins 'manual' and 'autopilot' as a third way an assistant write
-- can have been authorised.
ALTER TABLE ai_action_audit
    DROP CONSTRAINT ai_action_audit_source_check,
    ADD CONSTRAINT ai_action_audit_source_check
        CHECK (source IN ('manual', 'autopilot', 'coworker'));

ALTER TABLE ai_coworker_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_coworker_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_coworker_jobs FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE ai_coworker_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_coworker_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_coworker_events FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE ai_coworker_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_coworker_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_coworker_runs FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE ai_coworker_run_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_coworker_run_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_coworker_run_actions FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- Public API scopes
--
-- Phase 19's `/api/v1` exists so a business can build (or commission) a "sub
-- app" against its own data. The coworker is the first thing worth driving
-- from one — a bakery's own morning tablet, a bookkeeper's dashboard — so it
-- gets its own scopes rather than being folded into an existing one. Three,
-- because reading what the coworker is set up to do, changing that setup, and
-- approving a change it wants to make are three different levels of trust.
-- ---------------------------------------------------------------------------
ALTER TABLE api_keys
    DROP CONSTRAINT api_keys_scopes_check,
    ADD CONSTRAINT api_keys_scopes_check CHECK (
        cardinality(scopes) > 0
        AND scopes <@ ARRAY[
            'orders.read', 'orders.write', 'menu.read', 'menu.write',
            'inventory.read', 'reports.read', 'webhooks.manage',
            'accounting.read', 'coworker.read', 'coworker.write'
        ]::text[]
    );
