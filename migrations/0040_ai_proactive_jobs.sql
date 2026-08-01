-- Phase 18b Wave 4 — opt-in, tenant-scoped background assistant jobs.
--
-- Proactive work consumes a tenant's own AI credits, so its switch defaults
-- off. Run records and debt-message drafts are business data, not platform
-- data; every table below gets forced RLS in this same migration.

CREATE TABLE ai_proactive_settings (
    business_id             uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
    enabled                 boolean NOT NULL DEFAULT false,
    daily_digest_hour       smallint NOT NULL DEFAULT 8 CHECK (daily_digest_hour BETWEEN 0 AND 23),
    weekly_digest_weekday   smallint NOT NULL DEFAULT 6 CHECK (weekly_digest_weekday BETWEEN 0 AND 6),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_proactive_runs (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id             uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    kind                    text NOT NULL CHECK (kind IN ('daily_digest', 'weekly_digest', 'customer_debt_drafts')),
    period_key              text NOT NULL,
    status                  text NOT NULL DEFAULT 'running'
                                CHECK (status IN ('running', 'completed', 'skipped', 'failed')),
    content                 text,
    facts                   jsonb NOT NULL DEFAULT '{}'::jsonb,
    credit_request_id       uuid,
    error                   text,
    started_at              timestamptz NOT NULL DEFAULT now(),
    finished_at             timestamptz,
    UNIQUE (business_id, kind, period_key)
);
CREATE INDEX idx_ai_proactive_runs_business_started
    ON ai_proactive_runs (business_id, started_at DESC);
CREATE INDEX idx_ai_proactive_runs_running
    ON ai_proactive_runs (status, started_at) WHERE status = 'running';

CREATE TABLE ai_proactive_drafts (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id             uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    kind                    text NOT NULL CHECK (kind = 'customer_debt_follow_up'),
    customer_id             uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    customer_name           text NOT NULL,
    amount_rial             bigint NOT NULL CHECK (amount_rial > 0),
    period_key              text NOT NULL,
    content                 text NOT NULL,
    status                  text NOT NULL DEFAULT 'draft' CHECK (status = 'draft'),
    created_at              timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, kind, customer_id, period_key)
);
CREATE INDEX idx_ai_proactive_drafts_business_created
    ON ai_proactive_drafts (business_id, created_at DESC);

ALTER TABLE ai_proactive_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_proactive_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_proactive_settings FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE ai_proactive_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_proactive_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_proactive_runs FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE ai_proactive_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_proactive_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_proactive_drafts FOR ALL
    USING (
        app_rls_bypass()
        OR (
            business_id = app_current_business()
            AND EXISTS (
                SELECT 1 FROM customers c
                 WHERE c.id = customer_id AND c.business_id = app_current_business()
            )
        )
    )
    WITH CHECK (
        app_rls_bypass()
        OR (
            business_id = app_current_business()
            AND EXISTS (
                SELECT 1 FROM customers c
                 WHERE c.id = customer_id AND c.business_id = app_current_business()
            )
        )
    );
