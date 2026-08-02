-- AI Hub Wave 3 (Issue #143) — per-agent enable/disable instead of the single
-- ai_proactive_settings.enabled switch. The master switch keeps gating whether
-- any proactive background work runs at all for a business (it stays the
-- credit opt-in, unchanged); this table refines *which* agent's content is
-- generated once that master switch is on, so a manager can turn off
-- "پیگیری مطالبات" while leaving "تحلیلگر فروش" running.

CREATE TABLE ai_agent_settings (
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    agent_key       text NOT NULL CHECK (agent_key IN (
                        'financial_report_builder',
                        'sales_analyzer',
                        'receivables_follow_up',
                        'reconciliation_assistant'
                    )),
    enabled         boolean NOT NULL DEFAULT false,
    schedule_hour   smallint NOT NULL DEFAULT 8 CHECK (schedule_hour BETWEEN 0 AND 23),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, agent_key)
);

-- Backfill: a business that already had the single switch on keeps every
-- agent on (same effective behavior as before this migration); everyone
-- else starts with every agent off, same as a business that never opted in.
-- Missing rows default to disabled in application code, so businesses that
-- were already off need no row at all.
INSERT INTO ai_agent_settings (business_id, agent_key, enabled, schedule_hour)
SELECT s.business_id, agent_key, true, s.daily_digest_hour
  FROM ai_proactive_settings s
  CROSS JOIN (VALUES
        ('financial_report_builder'),
        ('sales_analyzer'),
        ('receivables_follow_up'),
        ('reconciliation_assistant')
  ) AS agents(agent_key)
 WHERE s.enabled;

ALTER TABLE ai_agent_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agent_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_agent_settings FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
