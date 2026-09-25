-- 0174_cloud_exception_responses.sql
-- Durable Cloud -> standalone-installation Support replies. Delivery is
-- at-least-once; a site records a tenant-scoped receipt before acknowledging.
CREATE TABLE cloud_exception_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id text NOT NULL REFERENCES cloud_exception_installations(installation_id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  admin_id uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz
);
CREATE INDEX idx_cloud_exception_responses_delivery
  ON cloud_exception_responses (installation_id, acknowledged_at, created_at);
ALTER TABLE cloud_exception_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_exception_responses FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON cloud_exception_responses FOR ALL
  USING (app_rls_bypass()) WITH CHECK (app_rls_bypass());

CREATE TABLE cloud_exception_response_receipts (
  response_id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_cloud_exception_response_receipts_business
  ON cloud_exception_response_receipts (business_id, applied_at DESC);
ALTER TABLE cloud_exception_response_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_exception_response_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cloud_exception_response_receipts FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
