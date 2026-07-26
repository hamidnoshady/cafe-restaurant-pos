-- ============================================================================
-- 0022_team_invitations.sql — Phase 13: teams & permissions
--
-- An invitation is how a person joins a business they aren't already a member
-- of. It carries everything the membership will be created with (role,
-- permission overrides, branches) so accepting is a single atomic step with no
-- second configuration round trip.
--
-- Decision (Phase 13 Q1): no email is sent. There is no mail transport
-- anywhere in this system, and adding one is a deployment concern rather than
-- a product one. The owner copies a link; the token is single-use and expires.
--
-- Only the token's sha-256 is stored, following the same rule as the Phase 9
-- rollup tokens: the plaintext is shown once at creation and is unrecoverable
-- afterwards, so a database read can never yield a usable invitation.
-- ============================================================================

CREATE TABLE invitations (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    email          citext NOT NULL,
    role           user_role NOT NULL,
    full_name      text NOT NULL,
    -- Same shape as users.permissions: { "granted": [...], "revoked": [...] }
    permissions    jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Branches the membership will be assigned to. Empty = every branch.
    location_ids   uuid[] NOT NULL DEFAULT '{}',
    token_hash     text NOT NULL UNIQUE,
    expires_at     timestamptz NOT NULL,
    invited_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    accepted_at    timestamptz,
    -- The membership this invitation produced, once accepted.
    accepted_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    revoked_at     timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_invitations_business ON invitations (business_id, created_at DESC);

-- At most one live invitation per (business, email): re-inviting someone should
-- replace their pending invitation, not accumulate tokens that all still work.
CREATE UNIQUE INDEX idx_invitations_pending_email
    ON invitations (business_id, email)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Phase 12 rule: a new tenant-scoped table needs its policy in the same
-- migration that creates it (see CLAUDE.md). invitations carries business_id,
-- so it takes the shape-1 policy.
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invitations FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- Removing a member has to be able to leave the row credential-less
-- ---------------------------------------------------------------------------
-- Every foreign key to users(id) is ON DELETE SET NULL, so deleting a member
-- would silently orphan "who opened this order" across the ledger and the
-- audit trail. Removal therefore deactivates and strips credentials instead
-- (Phase 13 decision: history stays attributed).
--
-- The 0020 constraint required every row to carry at least one credential,
-- which forbids exactly that. Its actual intent was that an *active* member
-- must have some way to sign in — a deactivated one, by definition, must not.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_credentials;
ALTER TABLE users ADD CONSTRAINT users_credentials CHECK (
    NOT is_active
    OR platform_user_id IS NOT NULL
    OR pin_hash IS NOT NULL
    OR password_hash IS NOT NULL
);
