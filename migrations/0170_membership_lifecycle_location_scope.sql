-- Canonical membership lifecycle and explicit branch policy.
-- Admin is a high-privilege tenant operator but remains distinct from Owner.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'admin';
-- The backfill intentionally preserves every legacy member's effective access:
-- assignments => selected, home branch => home, otherwise => all. It therefore
-- closes ambiguity without silently granting or removing access.
DO $$ BEGIN
  CREATE TYPE membership_status AS ENUM
    ('invited', 'active', 'suspended', 'locked', 'inactive', 'offboarded');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE location_scope AS ENUM ('all', 'selected', 'home', 'none');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS membership_status membership_status,
  ADD COLUMN IF NOT EXISTS location_scope location_scope;

UPDATE users
   SET membership_status = CASE WHEN is_active THEN 'active' ELSE 'inactive' END::membership_status
 WHERE membership_status IS NULL;

UPDATE users u
   SET location_scope = CASE
     WHEN u.role = 'owner' THEN 'all'
     WHEN EXISTS (SELECT 1 FROM user_locations ul WHERE ul.user_id = u.id) THEN 'selected'
     WHEN u.location_id IS NOT NULL THEN 'home'
     ELSE 'all'
   END::location_scope
 WHERE location_scope IS NULL;

ALTER TABLE users
  ALTER COLUMN membership_status SET DEFAULT 'active',
  ALTER COLUMN membership_status SET NOT NULL,
  ALTER COLUMN location_scope SET DEFAULT 'home',
  ALTER COLUMN location_scope SET NOT NULL;

CREATE INDEX IF NOT EXISTS users_business_membership_status_idx
  ON users (business_id, membership_status);

COMMENT ON COLUMN users.membership_status IS
  'Tenant membership lifecycle. Historical users are retained when offboarded.';
COMMENT ON COLUMN users.location_scope IS
  'Explicit branch policy; selected ids live in user_locations and home uses users.location_id.';
