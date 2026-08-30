-- ============================================================================
-- 0122_eshobe_cms_connection.sql — Eshobe headless CMS connection
--
-- The platform-owned website builder (eshobe-cms, a separate Payload 3
-- deployment) is connected per business through the same encrypted-credential
-- discipline the integration gateway uses (secrets.ts, migrations 0070/0103):
--
--   1. eshobe_cms_connections — one row per business: which CMS site it owns
--      (site_id), the site's domain (the tenant on the CMS), the CMS
--      control-plane origin, and the per-site API key encrypted at rest.
--      The key is AES-256-GCM ciphertext (secrets.ts) — plaintext only ever
--      exists inside the outbound HTTP client, exactly like WooCommerce
--      consumer secrets.
--
--   2. Standard tenant RLS: the same policy template every other tenant table
--      takes. UNIQUE (business_id): one CMS site per business in v1 — the
--      same rule the multi-location world keeps for the website manager
--      (the storefront is a business asset, not a per-branch one).
--
-- No change to core tables. Webhook verification is env-based
-- (ESHOBE_CMS_WEBHOOK_SECRET = the CMS's PAYLOAD_SECRET) and needs no column.
-- ============================================================================

CREATE TABLE eshobe_cms_connections (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- The CMS site's uuid (from POST /api/provision-site → site.id).
    site_id             text NOT NULL CHECK (char_length(trim(site_id)) BETWEEN 1 AND 100),
    -- The customer site's domain — the tenant the CMS resolves from Host.
    site_domain         text NOT NULL CHECK (char_length(trim(site_domain)) BETWEEN 1 AND 255),
    -- CMS control-plane origin (e.g. https://cms.eshobe.com), no trailing slash.
    base_url            text NOT NULL CHECK (char_length(trim(base_url)) BETWEEN 1 AND 255),
    key_name            text,
    -- Encrypted at rest through src/lib/integrations/secrets.ts.
    api_key_ciphertext  text NOT NULL,
    status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id)
);
CREATE INDEX idx_eshobe_cms_connections_business
    ON eshobe_cms_connections (business_id, created_at DESC);

-- Tenant isolation — the standard template, verbatim.
ALTER TABLE eshobe_cms_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE eshobe_cms_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON eshobe_cms_connections FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
