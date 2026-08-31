-- ============================================================================
-- 0128_app_availability.sql — turning an *app* off, with a reason.
--
-- Phase 15 gave the console `feature_flags` / `business_features`: one boolean
-- per capability. A boolean can only say "you do not have this", which is the
-- right answer for an entitlement ("this business did not buy inventory") and
-- the wrong answer for every other reason an app is not usable right now:
--
--   * the app is built but not released yet          → «به‌زودی»
--   * the app is briefly down for a migration/fix    → «در حال تعمیر و نگهداری»
--   * the app is released but still rough            → «نسخهٔ آزمایشی»
--   * the app is withdrawn from this deployment      → «غیرفعال»
--
-- Those are states of the *app* (src/lib/apps.ts — فروش, ارتباط با مشتری,
-- رشد و بازاریابی, عملیات, حسابداری, اتصال‌ها, تنظیمات), not of one flag, and
-- they are announced to the business rather than hidden from it: an app that
-- is off stays visible in the nav with its badge and opens an explanation
-- screen (see src/lib/app-availability.ts and
-- src/app/dashboard/app-availability-gate.tsx).
--
-- Two tables, exactly mirroring the flag pair the console already has:
--
--   app_availability           — the platform-wide state of each app. NOT
--                                tenant data and deliberately NOT RLS-protected,
--                                for the same reason `feature_flags` is not
--                                (see 0021): it is a global catalogue the
--                                super-admin console owns.
--   business_app_availability  — the per-business override, tenant data, RLS
--                                keyed on app_current_business() like
--                                `business_features`.
--
-- `app_key` is a plain text key rather than an FK: the app registry lives in
-- TypeScript (apps.ts), and the resolver ignores rows whose key is not in it,
-- so an app renamed in code cannot wedge a deployment on a stale row.
-- ============================================================================

-- Both tables share the vocabulary. Kept as a CHECK rather than an enum so a
-- later state is one migration and no type surgery.
CREATE TABLE app_availability (
    app_key        text PRIMARY KEY,
    state          text NOT NULL DEFAULT 'available'
                     CHECK (state IN ('available', 'beta', 'coming_soon', 'maintenance', 'disabled')),
    -- What the business is told, in the operator's own words. NULL falls back
    -- to the generic sentence for the state.
    note           text,
    -- When the app is expected back / to arrive. Stored as a Gregorian `date`
    -- (storage and the wire are always Gregorian); every screen renders it in
    -- Shamsi through src/lib/jalali.ts, per AGENTS.md.
    available_from date,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    updated_by     uuid REFERENCES platform_admins(id) ON DELETE SET NULL
);

CREATE TABLE business_app_availability (
    business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    app_key        text NOT NULL,
    state          text NOT NULL
                     CHECK (state IN ('available', 'beta', 'coming_soon', 'maintenance', 'disabled')),
    note           text,
    available_from date,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    updated_by     uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    PRIMARY KEY (business_id, app_key)
);

ALTER TABLE business_app_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_app_availability FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON business_app_availability;
CREATE POLICY tenant_isolation ON business_app_availability FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- Seed every app in today's registry as available, so this migration changes
-- no behaviour: the console is where an app is switched off. A key missing
-- from this table also resolves to 'available' (the resolver defaults), so a
-- future app needs no migration of its own.
INSERT INTO app_availability (app_key, state) VALUES
    ('sales',       'available'),
    ('crm',         'available'),
    ('growth',      'available'),
    ('operations',  'available'),
    ('accounting',  'available'),
    ('connections', 'available'),
    ('settings',    'available')
ON CONFLICT (app_key) DO NOTHING;
