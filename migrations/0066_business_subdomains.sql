-- Phase 21 Wave 3 — a business's public name becomes a DNS label.
--
-- Until now a tenant's identity lived in a URL *path*: middleware rewrote
-- /{slug}/dashboard/** to /dashboard/**, so every business was served from one
-- origin. That means one cookie jar, one localStorage, one service worker, and
-- one CSP/CORS boundary shared by every tenant on the deployment. Origin is
-- the browser's only real isolation primitive and we were not using it. This
-- migration is the schema half of moving each business onto its own origin,
-- {subdomain}.{ROOT_DOMAIN}.
--
-- `subdomain` is a NEW column rather than a rename of `slug`, deliberately.
-- They answer different questions and have different lifetimes:
--
--   slug      — the stable internal handle. Referenced by stored URLs, support
--               conversations, and anything that has ever written it down.
--               Never changes.
--   subdomain — the mutable public name. The super-admin can rename it when a
--               business rebrands, and the old host keeps working as an alias.
--
-- Conflating them would make renaming a business break every stored reference
-- to it, which is exactly the failure mode aliases exist to prevent.

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS subdomain citext;

-- Backfill from slug, so every existing business is immediately reachable at a
-- subdomain with no admin action and no migration of business content. The
-- `biz-xxxxxxxx` slugs 0020 generated come along as-is; the platform console
-- flags them so an admin can set a real name at leisure.
UPDATE businesses SET subdomain = slug WHERE subdomain IS NULL;

-- Same default as slug (0020) so restores, fixtures, and any future insert
-- path get a usable value without knowing about provisionBusiness.
ALTER TABLE businesses
    ALTER COLUMN subdomain SET DEFAULT ('biz-' || substr(gen_random_uuid()::text, 1, 8));
ALTER TABLE businesses ALTER COLUMN subdomain SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_businesses_subdomain ON businesses (subdomain);

-- ---------------------------------------------------------------------------
-- Old hosts after a rename
-- ---------------------------------------------------------------------------
-- Renaming a subdomain would otherwise dead-end every bookmark, printed
-- receipt, and saved shortcut pointing at the old host. An alias row keeps the
-- old name resolving to the same business so the Node-runtime resolver can
-- redirect it to the current one.
--
-- The alias must be unique across the whole table AND must not collide with a
-- live subdomain — the resolver checks businesses first, so a duplicate would
-- be silently unreachable rather than wrong, but a unique index makes the
-- conflict a write-time error instead of a mystery.
CREATE TABLE business_subdomain_aliases (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    alias       citext NOT NULL UNIQUE,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_business_subdomain_aliases_business
    ON business_subdomain_aliases (business_id, created_at DESC);

-- Tenant-scoped, so it needs a policy in the same migration that creates it —
-- integration/tenant-isolation.integration.test.ts asserts coverage over the
-- live schema and fails otherwise, and that failure is a real bug.
--
-- Note the resolver reads this table BEFORE any tenant has been chosen (the
-- host is what determines the tenant), so it goes through withoutTenantScope
-- for the same reason resolving a login email to its memberships does. The
-- policy still matters: every other reader — the platform console listing a
-- business's old hosts, a restore, a future report — runs scoped.
ALTER TABLE business_subdomain_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_subdomain_aliases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON business_subdomain_aliases FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
