-- ============================================================================
-- 0023_super_admin_console.sql — Phase 15: super-admin console
--
-- Phase 12 laid the tenancy foundation: platform_users, platform_admins,
-- platform_audit_log, businesses.status/plan, feature_flags/business_features.
-- Phase 15 is the operator's console that drives them. This migration adds the
-- three things the console needs that the schema didn't already have:
--
--   1. platform admins get a *role* of their own (support / engineer / owner),
--      so the most dangerous surfaces can be reserved for the most trusted
--      operators without every admin being all-powerful.
--   2. businesses gain an `archived_at` timestamp to record when a tenant was
--      archived — the grace window before a hard-delete becomes eligible.
--   3. `impersonation_grants` — the consent-and-time-limit trail for support
--      access. Entering a business is impossible without first writing one of
--      these rows, which names the admin, the business, the window and whether
--      the observer is read-only or full-access.
--
-- Like platform_admins and platform_audit_log, the new platform-realm table is
-- deliberately NOT under row-level security: it is only ever read through a
-- platform session (which runs RLS-bypassed by design, see src/lib/db.ts), and
-- a tenant-scoped connection has no route that touches it. See the note at the
-- end of migration 0021.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Platform admins get differentiated roles
-- ---------------------------------------------------------------------------
-- Open question 3 in the phase doc, answered: one level is not enough. Support
-- staff need to read health and enter a business read-only; engineers manage
-- flags and system state; only an owner provisions, hard-deletes, or grants
-- full-access impersonation. The presets live in src/lib/platform-admin.ts.
DO $$ BEGIN
    CREATE TYPE platform_admin_role AS ENUM ('support', 'engineer', 'owner');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Existing admins (created before this migration, e.g. the bootstrap admin)
-- default to 'owner' so nobody is locked out of what they could already do.
ALTER TABLE platform_admins
    ADD COLUMN IF NOT EXISTS role platform_admin_role NOT NULL DEFAULT 'owner';

-- ---------------------------------------------------------------------------
-- Businesses: the archive grace window
-- ---------------------------------------------------------------------------
-- status already carries 'archived' (migration 0020). This records *when* it
-- happened, which is what a retention policy counts from: a business is only
-- eligible for hard-delete once it has been archived for PLATFORM_DELETE_GRACE
-- days (open question 2, answered: grace window + export, never immediate).
ALTER TABLE businesses
    ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- ---------------------------------------------------------------------------
-- Impersonation grants — the consent trail for support access
-- ---------------------------------------------------------------------------
-- One row per time an admin enters a business. Written *before* the tenant
-- session is minted, so there is no way to impersonate without a record. The
-- window is [created_at, expires_at); ended_at/revoked_at close it early when
-- the admin leaves or another admin pulls the plug. mode is the blast radius:
-- 'read_only' sessions are blocked from every mutating request at the guard,
-- 'full' sessions can act as the business (and every such action is tagged).
CREATE TABLE IF NOT EXISTS impersonation_grants (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    platform_admin_id uuid NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
    business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- The membership the admin acts as inside the business (an owner row).
    -- Nullable so a grant survives that membership being deleted mid-window.
    user_id           uuid REFERENCES users(id) ON DELETE SET NULL,
    mode              text NOT NULL CHECK (mode IN ('read_only', 'full')),
    reason            text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    expires_at        timestamptz NOT NULL,
    -- Set when the admin explicitly leaves the business.
    ended_at          timestamptz,
    -- Set when a *different* admin revokes an active grant (kill switch).
    revoked_at        timestamptz,
    revoked_by        uuid REFERENCES platform_admins(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_impersonation_grants_admin
    ON impersonation_grants (platform_admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_impersonation_grants_business
    ON impersonation_grants (business_id, created_at DESC);
-- The "is this grant still live" lookup the guard runs on every impersonated
-- request: open grants only, newest first.
CREATE INDEX IF NOT EXISTS idx_impersonation_grants_active
    ON impersonation_grants (business_id)
    WHERE ended_at IS NULL AND revoked_at IS NULL;

-- impersonation_grants is a platform-realm table: NOT RLS-protected, on
-- purpose, for exactly the reasons platform_admins/platform_audit_log aren't
-- (see migration 0021's closing note). It is only ever read through a platform
-- session or from withoutTenantScope('platform', …).
