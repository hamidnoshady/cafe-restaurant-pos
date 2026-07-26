-- ============================================================================
-- 0020_platform_tenancy.sql — Phase 12: multi-business tenancy core
--
-- Turns a single-business install into a platform that hosts many businesses
-- in one database. See docs/phases/Phase-12-Multi-Business-Tenancy.md.
--
-- The load-bearing idea: `users` is NOT replaced. It becomes the *membership*
-- record — one row per (person × business) — carrying that business's role,
-- PIN, permission overrides and default branch. All 23 existing foreign keys
-- to users(id) keep meaning exactly what they meant ("which staff member of
-- this business did this"), so nothing downstream has to change.
--
-- The global login identity moves up into platform_users:
--
--   platform_users ──< users ──< user_locations
--   (email+password)   (membership: business, role, pin, permissions)
--
-- Row-Level Security is a separate migration (0021) so the schema change and
-- the isolation policies can be reviewed independently.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
-- Phase 16 needs a role that can work the books without running the floor.
-- Added here (not in 0021) because a new enum value cannot be USED in the same
-- transaction that adds it, and migrations run one-file-per-transaction.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'accountant';

DO $$ BEGIN
    CREATE TYPE business_status AS ENUM ('active', 'suspended', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Global identity
-- ---------------------------------------------------------------------------
-- One row per person who logs in with an email + password, regardless of how
-- many businesses they belong to. PIN-only staff (cashier/waiter/kitchen) have
-- no row here — they authenticate against their membership's pin_hash instead.
CREATE TABLE platform_users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         citext NOT NULL UNIQUE,
    password_hash text NOT NULL,
    full_name     text NOT NULL,
    is_active     boolean NOT NULL DEFAULT true,
    last_login_at timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Super-user realm
-- ---------------------------------------------------------------------------
-- Deliberately NOT a row in any business's users table: a platform admin
-- administers the deployment and is not a member of anything. Their session
-- is a different cookie and cannot be used against a tenant API route.
CREATE TABLE platform_admins (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         citext NOT NULL UNIQUE,
    password_hash text NOT NULL,
    full_name     text NOT NULL,
    is_active     boolean NOT NULL DEFAULT true,
    last_login_at timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Every privileged cross-tenant action. Separate from audit_log because that
-- one is tenant-scoped (and RLS'd) — this one spans businesses by design.
CREATE TABLE platform_audit_log (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    platform_admin_id uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    business_id       uuid REFERENCES businesses(id) ON DELETE SET NULL,
    action            text NOT NULL,
    entity            text,
    entity_id         text,
    payload           jsonb,
    created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_platform_audit_log_time ON platform_audit_log (created_at DESC);
CREATE INDEX idx_platform_audit_log_business ON platform_audit_log (business_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Businesses become tenants with a lifecycle
-- ---------------------------------------------------------------------------
ALTER TABLE businesses
    ADD COLUMN IF NOT EXISTS slug         citext,
    ADD COLUMN IF NOT EXISTS status       business_status NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS plan         text NOT NULL DEFAULT 'standard',
    ADD COLUMN IF NOT EXISTS timezone     text NOT NULL DEFAULT 'Asia/Tehran',
    ADD COLUMN IF NOT EXISTS suspended_at timestamptz,
    ADD COLUMN IF NOT EXISTS updated_at   timestamptz NOT NULL DEFAULT now();

-- Backfill a slug for any business that predates this migration, then make it
-- required. Slugs are how a business is identified in a URL or a support
-- conversation without leaking a uuid.
UPDATE businesses SET slug = 'biz-' || substr(id::text, 1, 8) WHERE slug IS NULL;

-- Every business gets a usable slug even when the caller doesn't supply one —
-- `provisionBusiness` derives a readable one from the name (see src/lib/slug.ts),
-- but restores, fixtures and any future insert path shouldn't have to know that.
-- The unique index below is what catches the astronomically unlikely collision.
ALTER TABLE businesses
    ALTER COLUMN slug SET DEFAULT ('biz-' || substr(gen_random_uuid()::text, 1, 8));
ALTER TABLE businesses ALTER COLUMN slug SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_businesses_slug ON businesses (slug);

-- ---------------------------------------------------------------------------
-- users becomes the membership record
-- ---------------------------------------------------------------------------
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS platform_user_id uuid REFERENCES platform_users(id) ON DELETE CASCADE,
    -- { "granted": ["ledger.post"], "revoked": ["menu.edit"] } layered on top
    -- of the role preset. See src/lib/permissions.ts.
    ADD COLUMN IF NOT EXISTS permissions      jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Promote every existing email+password user to a global identity, so an
-- install that already ran the Phase 1 wizard keeps working and its owner can
-- log in unchanged. Emails were globally unique until now, so this is 1:1.
INSERT INTO platform_users (email, password_hash, full_name, is_active, created_at)
SELECT u.email, u.password_hash, u.full_name, u.is_active, u.created_at
  FROM users u
 WHERE u.email IS NOT NULL
   AND u.password_hash IS NOT NULL
ON CONFLICT (email) DO NOTHING;

UPDATE users u
   SET platform_user_id = p.id
  FROM platform_users p
 WHERE p.email = u.email
   AND u.platform_user_id IS NULL;

-- Email was globally unique, which is exactly what stopped one person from
-- belonging to two businesses. Uniqueness moves to platform_users (globally)
-- and to (business_id, email) here.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_business_email
    ON users (business_id, email) WHERE email IS NOT NULL;

-- One membership per person per business.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_business_platform_user
    ON users (business_id, platform_user_id) WHERE platform_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_platform_user ON users (platform_user_id)
    WHERE platform_user_id IS NOT NULL;

-- A membership authenticates by password (via its platform identity) or by
-- PIN (staff on the floor). It must have at least one way in.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_credentials;
ALTER TABLE users ADD CONSTRAINT users_credentials
    CHECK (platform_user_id IS NOT NULL OR pin_hash IS NOT NULL OR password_hash IS NOT NULL);

-- ---------------------------------------------------------------------------
-- Per-user branch scoping (Phase 14 builds the switcher on top of this)
-- ---------------------------------------------------------------------------
-- users.location_id stays as the member's default branch. This table is the
-- full set they may reach; empty set + owner role means "all branches".
CREATE TABLE user_locations (
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, location_id)
);
CREATE INDEX idx_user_locations_location ON user_locations (location_id);

-- Existing users keep reaching the branch they were pinned to.
INSERT INTO user_locations (user_id, location_id)
SELECT id, location_id FROM users WHERE location_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Feature flags & entitlements
-- ---------------------------------------------------------------------------
-- Phase 15 administers these, Phase 17 enforces them. Modelled here because
-- the tenancy layer is where "what is this business allowed to do" belongs.
CREATE TABLE feature_flags (
    key             text PRIMARY KEY,
    name            text NOT NULL,
    description     text,
    default_enabled boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE business_features (
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    flag_key    text NOT NULL REFERENCES feature_flags(key) ON DELETE CASCADE,
    enabled     boolean NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, flag_key)
);

-- The features that already exist as built phases. Everything defaults on so
-- this migration changes no behaviour; Phase 15 is where they get turned off.
INSERT INTO feature_flags (key, name, description, default_enabled) VALUES
    ('inventory',   'موجودی و انبار',        'ردیابی موجودی، دستور پخت و بهای تمام‌شده',      true),
    ('ledger',      'دفتر حسابداری',          'ثبت دوطرفه، تراز آزمایشی و صورت‌های مالی',       true),
    ('reservations','رزرو میز',               'رزرو میز و مدیریت سالن',                        true),
    ('delivery',    'ارسال و پیک',            'سفارش ارسالی، پیک و پیگیری تحویل',              true),
    ('reporting',   'گزارش‌ها و تحلیل',        'گزارش‌های فروش، کارکنان و داشبورد',              true),
    ('multi_location','چند شعبه',             'مدیریت چند شعبه زیر یک کسب‌وکار',                true),
    ('offline_mode','کار بدون اینترنت',       'صف آفلاین و همگام‌سازی سرور محلی',               true),
    ('backup',      'پشتیبان‌گیری',            'پشتیبان‌گیری و بازیابی خودکار',                  true),
    ('ai_assistant','دستیار هوشمند',          'دستیار گفت‌وگومحور روی داده‌های کسب‌وکار',        false)
ON CONFLICT (key) DO NOTHING;
