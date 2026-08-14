-- Phase 23 follow-up — impersonation sessions move onto the business's own origin.
--
-- Before this migration, the super-admin console's "enter business" flow minted
-- the tenant session on admin.{ROOT_DOMAIN} — the host the console runs on — and
-- navigated to /dashboard there. That worked (middleware exempts the console
-- host from the tenant-origin check) but it placed a tenant session inside the
-- console's browser origin, which is the exact sharing Phase 23 removes.
--
-- A host-scoped cookie (see src/lib/auth-edge.ts — there is deliberately no
-- `domain` attribute) can only be sent back to the host that set it, so the
-- console cannot set the business's cookie for it. The handoff is the answer:
-- the console writes the grant (already done, atomically) *and* a short-lived,
-- single-use token here; the browser then redeems that token on the business's
-- own origin, which is where the tenant session is actually minted.
--
-- One row per "enter" click. The plaintext is returned once, in the handoff
-- URL; only its SHA-256 hash is stored, matching the invitations / employee
-- sessions / device tokens / API keys pattern — a database read alone can never
-- yield a usable token. The window is deliberately tiny (a few minutes): the
-- token only has to survive the one browser hop from the console to the
-- business host, and short-lived means a leaked token stops working almost
-- immediately.
CREATE TABLE IF NOT EXISTS impersonation_handoffs (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    grant_id    uuid NOT NULL REFERENCES impersonation_grants(id) ON DELETE CASCADE,
    token_hash  text NOT NULL UNIQUE,
    expires_at  timestamptz NOT NULL,
    -- Set once, atomically, when the token is redeemed — the single-use check.
    redeemed_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_impersonation_handoffs_grant
    ON impersonation_handoffs (grant_id);

-- Like impersonation_grants (migration 0023), this carries no business_id of
-- its own but is reachable through its grant, which does. It is only ever
-- written or read through a bypass scope (the platform console, or the
-- session-less handoff redemption on the business origin), but it is brought
-- under row-level security for defence in depth so a tenant-scoped connection
-- can never see another business's handoffs — and to keep the
-- integration/tenant-isolation coverage check (which asserts every public table
-- has a policy) honest.
ALTER TABLE impersonation_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE impersonation_handoffs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON impersonation_handoffs;
CREATE POLICY tenant_isolation ON impersonation_handoffs FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM impersonation_grants g
         WHERE g.id = grant_id AND g.business_id = app_current_business()
    ))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM impersonation_grants g
         WHERE g.id = grant_id AND g.business_id = app_current_business()
    ));
