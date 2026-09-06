-- ============================================================================
-- 0138_website_management.sql — «مدیریت وب‌سایت»: one app, two managers, and
-- the platform-side billing for the site it hosts.
--
-- Three things, in one forward-only step:
--
--   1. The app merge. `wp` (the WordPress/WooCommerce manager) and `website`
--      (the Eshobe CMS connection) were two peers in the workspace rail. They
--      are now two *managers* inside one app, `website` — see the note on that
--      entry in src/lib/apps.ts. `app_availability` / `business_app_availability`
--      key their rows on the app key, so the operator's «به‌زودی» / «در حال
--      تعمیر» state for the WP manager has to travel with it or it silently
--      stops applying. A `wp` row wins only where the merged app has none:
--      an operator who already set a state for `website` said something about
--      the app that now owns both.
--
--   2. `website_setup` — the CMS site-building wizard's state. The order is the
--      order the owner works in: domain (buy one through the platform, or point
--      one they own) → ArvanCloud CDN → what kind of site this is → build. The
--      row records the *choices*; the site itself is created on the CMS at the
--      build step, and the connection lands in `eshobe_cms_connections` (0122)
--      exactly as a hand-made connection does. One row per business, because a
--      business runs one platform site.
--
--   3. `website_service_plans` / `website_service_subscriptions` /
--      `website_service_charges` — who pays for that site, and for what.
--      «سایت‌ساز کار سایت را می‌کند؛ پول را این‌جا می‌گیریم.» The CMS renders
--      and serves; it has no idea what a business owes. Every Rial — the
--      monthly site fee, a domain registration or renewal bought through the
--      platform's registrar, a one-off setup — is a row here, charged against
--      the platform wallet the business already tops up (migration 0130), so a
--      website invoice and an AI-credit invoice come out of one balance.
--
--      The catalogue is global (no business_id, no RLS — the same shape as
--      `billing_plans` / `credit_packages`, and listed in
--      src/lib/tenant-tables.ts's EXEMPT_TABLES with them). The subscription
--      and the charges are tenant data and are RLS-protected here, per CLAUDE.md.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The app merge: `wp` state becomes `website` state.
-- ---------------------------------------------------------------------------

-- Platform-wide rows. `website` already having a row means the operator has
-- spoken about the merged app; the stale `wp` row is then dropped rather than
-- allowed to overwrite it.
DELETE FROM app_availability
      WHERE app_key = 'wp'
        AND EXISTS (SELECT 1 FROM app_availability existing WHERE existing.app_key = 'website');
UPDATE app_availability SET app_key = 'website', updated_at = now() WHERE app_key = 'wp';

-- Per-business overrides, same rule, per business.
DELETE FROM business_app_availability wp
      WHERE wp.app_key = 'wp'
        AND EXISTS (
              SELECT 1 FROM business_app_availability existing
               WHERE existing.business_id = wp.business_id
                 AND existing.app_key = 'website');
UPDATE business_app_availability SET app_key = 'website', updated_at = now() WHERE app_key = 'wp';

-- ---------------------------------------------------------------------------
-- 2. The CMS site-building wizard.
-- ---------------------------------------------------------------------------

CREATE TABLE website_setup (
    business_id       uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
    -- The furthest step the owner has completed. `built` means the site exists
    -- on the CMS and eshobe_cms_connections holds its key.
    step              text NOT NULL DEFAULT 'domain'
                          CHECK (step IN ('domain', 'cdn', 'type', 'build', 'built')),
    -- Step 1 — the domain. `own` = the owner already has it and will point DNS
    -- at the platform; `buy` = the platform's registrar registers it for them
    -- and the fee lands in website_service_charges.
    domain            text,
    domain_mode       text NOT NULL DEFAULT 'own' CHECK (domain_mode IN ('own', 'buy')),
    domain_status     text NOT NULL DEFAULT 'pending'
                          CHECK (domain_status IN ('pending', 'ordered', 'registered', 'failed')),
    -- The registrar operation this domain was ordered under, as the CMS
    -- reported it. Kept so a pending order can be followed up without asking
    -- the owner to remember a reference.
    domain_reference  text,
    domain_years      integer NOT NULL DEFAULT 1 CHECK (domain_years BETWEEN 1 AND 5),
    -- Step 2 — the CDN. The zone lives on the CMS (cdn-zones); this records
    -- what the owner asked for and what was last observed, so the wizard can
    -- be resumed on another device.
    cdn_provider      text NOT NULL DEFAULT 'arvancloud'
                          CHECK (cdn_provider IN ('arvancloud', 'cloudflare', 'none')),
    cdn_status        text NOT NULL DEFAULT 'pending'
                          CHECK (cdn_status IN ('pending', 'requested', 'active', 'failed', 'skipped')),
    cdn_note          text,
    -- Step 3 — what kind of site this is. The same vocabulary the CMS uses for
    -- a site's `type`, because it is passed straight to POST /api/provision-site.
    site_type         text NOT NULL DEFAULT 'business'
                          CHECK (site_type IN ('business', 'portfolio', 'store')),
    site_name         text,
    -- Step 4 — which plan the built site runs on (website_service_plans.key).
    plan_key          text,
    built_at          timestamptz,
    last_error        text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE website_setup ENABLE ROW LEVEL SECURITY;
ALTER TABLE website_setup FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON website_setup FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 3. Billing for the platform site.
-- ---------------------------------------------------------------------------

-- The catalogue the super-admin maintains. Global, like billing_plans.
CREATE TABLE website_service_plans (
    key                 text PRIMARY KEY,
    name                text NOT NULL,
    description         text,
    -- What the site costs per month, in integer Rial (the repo-wide unit).
    monthly_price_rial  bigint NOT NULL DEFAULT 0 CHECK (monthly_price_rial >= 0),
    -- A one-off charge on the first build (site setup), if the operator wants one.
    setup_price_rial    bigint NOT NULL DEFAULT 0 CHECK (setup_price_rial >= 0),
    -- Which site types this plan may be used for. Empty = every type.
    site_types          text[] NOT NULL DEFAULT ARRAY[]::text[],
    includes_cdn        boolean NOT NULL DEFAULT true,
    -- Whether the plan's monthly fee covers one domain registration.
    includes_domain     boolean NOT NULL DEFAULT false,
    -- Soft ceilings the manager shows; enforcement is the CMS's business.
    max_products        integer,
    max_pages           integer,
    is_active           boolean NOT NULL DEFAULT true,
    sort_order          integer NOT NULL DEFAULT 0,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- One subscription per business: it runs one platform site.
CREATE TABLE website_service_subscriptions (
    business_id          uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
    plan_key             text NOT NULL REFERENCES website_service_plans(key) ON DELETE RESTRICT,
    status               text NOT NULL DEFAULT 'active'
                             CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled')),
    -- Both Gregorian/ISO, as every timestamp in this repo is; every screen
    -- renders them in Shamsi through src/lib/jalali.ts.
    started_at           timestamptz NOT NULL DEFAULT now(),
    current_period_start timestamptz NOT NULL DEFAULT now(),
    current_period_end   timestamptz NOT NULL,
    auto_renew           boolean NOT NULL DEFAULT true,
    cancelled_at         timestamptz,
    -- The price agreed at subscribe time. A later catalogue change must not
    -- silently reprice a running site.
    monthly_price_rial   bigint NOT NULL DEFAULT 0 CHECK (monthly_price_rial >= 0),
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE website_service_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE website_service_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON website_service_subscriptions FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

CREATE TABLE website_service_charges (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    kind             text NOT NULL
                         CHECK (kind IN ('setup', 'subscription', 'domain_registration',
                                         'domain_renewal', 'domain_transfer', 'cdn', 'adjustment')),
    description      text NOT NULL,
    amount_rial      bigint NOT NULL CHECK (amount_rial >= 0),
    occurred_at      timestamptz NOT NULL DEFAULT now(),
    period_start     timestamptz,
    period_end       timestamptz,
    -- Idempotency: the period a subscription charge covers, or the registrar
    -- operation a domain charge belongs to. A retry must not bill twice.
    reference        text NOT NULL,
    -- The wallet row this charge was settled from (wallet_ledger.id), or NULL
    -- when it was recorded without a debit (a promo, or a manual adjustment).
    wallet_ledger_id uuid,
    created_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, kind, reference)
);
CREATE INDEX idx_website_service_charges_business
    ON website_service_charges (business_id, occurred_at DESC);

ALTER TABLE website_service_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE website_service_charges FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON website_service_charges FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- A starting catalogue, so the manager has something to show on a fresh
-- deployment. Prices are the operator's to change from the console; zero here
-- would read as "free forever", which is a claim this migration must not make
-- on the operator's behalf — these are placeholders they are expected to set.
INSERT INTO website_service_plans
    (key, name, description, monthly_price_rial, setup_price_rial, site_types,
     includes_cdn, includes_domain, max_products, max_pages, sort_order)
VALUES
    ('site_starter', 'سایت پایه',
     'یک سایت معرفی کسب‌وکار با صفحه‌های ثابت، وبلاگ و فرم تماس.',
     2000000, 0, ARRAY['business', 'portfolio'], true, false, NULL, 20, 10),
    ('site_store', 'سایت فروشگاهی',
     'فروشگاه اینترنتی با محصول، سبد خرید، درگاه پرداخت و همگام‌سازی قیمت و موجودی با صندوق.',
     5000000, 0, ARRAY['store'], true, false, 500, 50, 20)
ON CONFLICT (key) DO NOTHING;
