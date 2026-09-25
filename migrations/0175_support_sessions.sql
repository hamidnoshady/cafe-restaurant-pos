-- Support Access hardening: keep the existing grant/handoff source of truth,
-- but make its lifecycle, ticket relationship and customer policy explicit.
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS support_access_policy text NOT NULL DEFAULT 'standard'
    CHECK (support_access_policy IN ('standard', 'approval_required', 'strict', 'disabled'));

ALTER TABLE impersonation_grants DROP CONSTRAINT IF EXISTS impersonation_grants_mode_check;
ALTER TABLE impersonation_grants
  ADD CONSTRAINT impersonation_grants_mode_check
  CHECK (mode IN ('read_only', 'controlled', 'full', 'emergency'));

ALTER TABLE impersonation_grants
  ADD COLUMN IF NOT EXISTS ticket_id uuid REFERENCES support_tickets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ended_by_type text CHECK (ended_by_type IN ('operator', 'platform_admin', 'tenant_admin', 'system')),
  ADD COLUMN IF NOT EXISTS ended_by_id uuid,
  ADD COLUMN IF NOT EXISTS emergency boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allowed_capabilities text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS platform_admin_token_version integer;

UPDATE impersonation_grants g
   SET platform_admin_token_version = a.token_version
  FROM platform_admins a
 WHERE a.id = g.platform_admin_id AND g.platform_admin_token_version IS NULL;

CREATE INDEX IF NOT EXISTS idx_impersonation_grants_ticket
  ON impersonation_grants (ticket_id, created_at DESC) WHERE ticket_id IS NOT NULL;

-- Serialize starts for one operator/business without an invalid NOW()-based
-- partial unique index.  The transaction takes this advisory lock before it
-- checks for a still-live row.
CREATE INDEX IF NOT EXISTS idx_impersonation_grants_operator_business_open
  ON impersonation_grants (platform_admin_id, business_id, expires_at)
  WHERE ended_at IS NULL AND revoked_at IS NULL;
