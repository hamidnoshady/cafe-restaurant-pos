-- 0173_cloud_exception_relay.sql
-- Durable, narrowly-scoped Local/Hybrid -> Cloud delivery for the only two
-- cloud-connected functions allowed in a fully Local profile: Support and Bug
-- Report. This queue is deliberately separate from operational site sync.

CREATE TABLE cloud_exception_outbox (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('support.ticket.created','support.message.created','bug_report.created')),
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  last_error_code text
);
CREATE INDEX idx_cloud_exception_outbox_due
  ON cloud_exception_outbox (business_id, next_attempt_at, lease_until, occurred_at);
ALTER TABLE cloud_exception_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_exception_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cloud_exception_outbox FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- Central installation credentials are independent from Cloud tenants: asking
-- for help must not silently provision or merge operational business data.
CREATE TABLE cloud_exception_installations (
  installation_id text PRIMARY KEY CHECK (char_length(installation_id) BETWEEN 8 AND 200),
  label text NOT NULL DEFAULT '',
  token_hash char(64) NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
ALTER TABLE cloud_exception_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_exception_installations FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON cloud_exception_installations FOR ALL
  USING (app_rls_bypass()) WITH CHECK (app_rls_bypass());

CREATE TABLE cloud_exception_inbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  installation_id text NOT NULL REFERENCES cloud_exception_installations(installation_id) ON DELETE RESTRICT,
  event_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('support.ticket.created','support.message.created','bug_report.created')),
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (installation_id, event_id)
);
CREATE INDEX idx_cloud_exception_inbox_received ON cloud_exception_inbox (received_at DESC);
ALTER TABLE cloud_exception_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_exception_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON cloud_exception_inbox FOR ALL
  USING (app_rls_bypass()) WITH CHECK (app_rls_bypass());
