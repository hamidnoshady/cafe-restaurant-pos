-- ============================================================================
-- 0048_install_pairing_codes.sql — desktop first-run pairing
--
-- A pairing code is how a desktop install claims an existing business that was
-- provisioned on the online platform. An operator issues one from the
-- super-admin console and hands it to the owner out-of-band; redeeming it
-- returns a one-time snapshot of the business configuration, which the local
-- install replays into its empty database.
--
-- Only the code's sha-256 is stored, following the same rule as the Phase 13
-- invitations and the Phase 9 rollup tokens: the plaintext is shown once at
-- creation and is unrecoverable afterwards, so a database read can never yield
-- a usable code.
-- ============================================================================

CREATE TABLE install_pairing_codes (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id  uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    code_hash    text NOT NULL UNIQUE,
    expires_at   timestamptz NOT NULL,
    issued_by    uuid REFERENCES platform_users(id) ON DELETE SET NULL,
    redeemed_at  timestamptz,
    redeemed_ip  inet,
    revoked_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_pairing_codes_business ON install_pairing_codes (business_id, created_at DESC);

-- At most one live code per business: re-issuing should replace the pending
-- code, not accumulate several that all still work.
CREATE UNIQUE INDEX idx_pairing_codes_live_business
    ON install_pairing_codes (business_id)
    WHERE redeemed_at IS NULL AND revoked_at IS NULL;

-- Phase 12 rule: a new tenant-scoped table needs its policy in the same
-- migration that creates it (see CLAUDE.md). install_pairing_codes carries
-- business_id, so it takes the standard shape.
ALTER TABLE install_pairing_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE install_pairing_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON install_pairing_codes FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
