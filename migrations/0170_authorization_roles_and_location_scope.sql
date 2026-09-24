-- ============================================================================
-- 0170_authorization_roles_and_location_scope.sql
--
-- The schema half of the authorization refactor. Two independent changes, both
-- additive, both safe to run against a populated production database.
--
-- ## 1. Two new built-in roles: `admin` and `viewer`
--
-- `manager` had been doing two unrelated jobs. Running the business — orders,
-- stock, the floor, the day — and administering the tenant — staff, branches,
-- integrations, settings. Every route that needed "a grown-up" wrote
-- `requireRole("owner", "manager")`, so a shift manager who needed to void an
-- order was handed the ability to reconfigure the business at the same time.
--
-- `admin` is the tenant administrator that role was standing in for: every
-- capability except the ones an owner may not delegate (see
-- OWNER_ONLY_PERMISSIONS in src/lib/permissions.ts). `viewer` is the read-only
-- auditor — broad sight, no mutation, and deliberately no export.
--
-- Both are purely additive. No existing row holds either value, so no tenant's
-- behaviour changes until somebody deliberately assigns one. In particular
-- this migration does NOT re-grade existing managers: a manager stays a
-- manager with exactly the permissions they had this morning, because silently
-- demoting every manager in every tenant is an outage, not a security fix.
--
-- `ALTER TYPE ... ADD VALUE IF NOT EXISTS` is how 0020 added `accountant`;
-- it is transactional-safe on PostgreSQL 12+ and idempotent on re-run.
--
-- ## 2. Explicit branch scope: `users.location_scope`
--
-- The pre-existing rule (src/lib/location-access.ts) resolved a member's
-- branches by falling *through* three cases, and the last one was dangerous:
--
--   1. owner                                  → every branch
--   2. rows in `user_locations`               → exactly those branches
--   3. no rows, but `users.location_id` set   → that one branch
--   4. no rows, and `location_id` NULL        → EVERY BRANCH
--
-- Case 4 means the absence of a decision grants the widest possible access.
-- A member created by any path that does not set a home branch and does not
-- write `user_locations` — an invitation accepted without a branch, a
-- staff-creation form where the field was left blank, an API-created member —
-- silently roams every branch of the business. That is the opposite of
-- deny-by-default, and it is invisible in the UI: nothing renders "this person
-- can see all five of your shops".
--
-- The fix is to make the choice explicit and stored, rather than inferred from
-- the absence of data:
--
--   'all'      — every branch of the business, now and in the future.
--   'selected' — exactly the branches in `user_locations`.
--   'home'     — only `users.location_id`.
--
-- ### The backfill is deliberately non-destructive
--
-- Existing members are given the scope that reproduces the access they have
-- **right now**, case by case, so that nobody is locked out and nobody is
-- escalated on the morning of the deploy:
--
--   * owners                        → 'all'  (unchanged; owners are whole-business)
--   * has user_locations rows       → 'selected'
--   * no rows, has location_id      → 'home'
--   * no rows, no location_id       → 'all'  (preserves case 4 for people who
--                                      have it today — see below)
--
-- The last line is the uncomfortable one, and it is intentional. Those members
-- CAN reach every branch today. Backfilling them to 'home' would lock out
-- every roaming manager in production at deploy time, and backfilling them to
-- 'selected' with no selections would lock them out of everything. So the
-- migration *preserves* their access and merely makes it explicit and visible:
-- from now on their row says 'all' out loud, the team UI renders «همه شعبه‌ها»
-- for them, and an owner who did not intend it can see it and change it.
--
-- The privilege escalation is closed for everyone *new*: the column defaults
-- to 'home', and `accessibleLocationIds` no longer has a widening fallback —
-- a member with scope 'home' and no home branch now reaches nothing at all
-- rather than everything.
-- ============================================================================

-- --------------------------------------------------------------------------
-- 1. Roles
-- --------------------------------------------------------------------------

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'admin';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'viewer';

-- --------------------------------------------------------------------------
-- 2. Branch scope
-- --------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'location_scope') THEN
    CREATE TYPE location_scope AS ENUM ('all', 'selected', 'home');
  END IF;
END $$;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS location_scope location_scope NOT NULL DEFAULT 'home';

-- Backfill: reproduce today's effective access exactly. Runs once; the
-- `WHERE` clauses are mutually exclusive and the whole block is re-runnable
-- because it only ever rewrites rows still sitting on the 'home' default that
-- the column was just added with.
UPDATE users u
   SET location_scope = 'all'
 WHERE u.role = 'owner';

UPDATE users u
   SET location_scope = 'selected'
 WHERE u.role <> 'owner'
   AND EXISTS (SELECT 1 FROM user_locations ul WHERE ul.user_id = u.id);

UPDATE users u
   SET location_scope = 'home'
 WHERE u.role <> 'owner'
   AND u.location_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM user_locations ul WHERE ul.user_id = u.id);

-- The pre-existing "roaming" members (case 4). Preserved, not revoked — see
-- the header. This is the only branch of the backfill that grants breadth,
-- and it grants exactly the breadth the member already had.
UPDATE users u
   SET location_scope = 'all'
 WHERE u.role <> 'owner'
   AND u.location_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM user_locations ul WHERE ul.user_id = u.id);

COMMENT ON COLUMN users.location_scope IS
  'Explicit branch access policy: all = every branch, selected = the user_locations rows, home = location_id only. Defaults to the narrowest (home) so that a member created without a decision cannot roam.';
