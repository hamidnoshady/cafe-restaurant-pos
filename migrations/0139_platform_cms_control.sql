-- ============================================================================
-- 0139_platform_cms_control.sql — the super-admin console's CMS control plane.
--
-- Migration 0122 connected ONE BUSINESS to its own site on eshobe-cms: a site
-- key, encrypted, RLS'd, used by that business's «مدیریت وب‌سایت» app. That is
-- the tenant half and it is unchanged.
--
-- What had no home at all is the OPERATOR half. Every superadmin function of
-- the website platform — provisioning sites, issuing and revoking keys,
-- suspending a site, reading the fleet's health, exporting and restoring a
-- site's content — lived only inside the CMS's own /admin, on another host,
-- behind another login. The super-admin console already administers every
-- other part of this platform (businesses, billing, backups, updates,
-- observability); this migration is what lets it administer that one too, from
-- one address and one credential:
--
--   platform_cms_config    A singleton, exactly the shape of
--                          platform_update_config / platform_payment_config /
--                          platform_message_config (0038 / 0130): the CMS's
--                          base URL and its `role: "platform"` API key,
--                          AES-256-GCM at rest (src/lib/integrations/secrets.ts),
--                          plus the sync/logging switches and the cursor the
--                          event shipper polls from.
--
--   platform_cms_sites     A MIRROR of the fleet report, one row per CMS site.
--                          Not a second source of truth: the CMS owns these
--                          rows and this table is what the console renders when
--                          the CMS is unreachable, and what a report can be
--                          computed over without N calls across the network.
--                          Every column is last-known-good, stamped with the
--                          moment it was read.
--
--   platform_cms_sync_runs One row per sync, in either direction, with what it
--                          touched and what it cost. A content restore that
--                          nobody can point at afterwards is not an operation,
--                          it is an incident.
--
-- None of the three carries a business_id: they belong to the DEPLOYMENT, the
-- same reasoning spelled out in 0021 and repeated by every platform_* table
-- since, and mirrored in src/lib/tenant-tables.ts's EXEMPT_TABLES (which
-- integration/tenant-isolation.integration.test.ts pins). A tenant must never
-- read the operator's credential for the platform that hosts every customer's
-- website — which is precisely why this is not an extension of 0122's
-- per-business table.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- The connection: one address, one platform key
-- ---------------------------------------------------------------------------
CREATE TABLE platform_cms_config (
    id                     boolean PRIMARY KEY DEFAULT true CHECK (id),

    -- The CMS control-plane origin, no trailing slash. Normalized and validated
    -- by src/lib/cms/platform-config.ts before it is ever stored — same rules as
    -- a backup peer's address (0132): no credentials in the URL, no query, no
    -- fragment, http only when the operator explicitly allowed it.
    base_url               text NOT NULL DEFAULT '' CHECK (char_length(base_url) <= 512),
    -- An operator label, so a console showing two deployments says which.
    label                  text NOT NULL DEFAULT '' CHECK (char_length(label) <= 120),
    -- http:// is refused unless this is on: a CMS on the same private network
    -- (http://web:3000) is legitimate, a CMS reached over the public internet
    -- without TLS is a mistake, and only the operator can tell them apart.
    allow_insecure         boolean NOT NULL DEFAULT false,

    -- `role: "platform"` key, AES-256-GCM (src/lib/integrations/secrets.ts).
    -- NULL means "no credential stored"; an EMPTY SUBMISSION never clears it —
    -- the form renders masked, so treating empty as deletion would wipe the
    -- credential the moment somebody edited the label (the same rule the CMS's
    -- own gateway credentials keep).
    api_key_ciphertext     text,
    -- Last four characters of the raw key, so the console can show WHICH key is
    -- stored without being able to show the key. Never enough to authenticate.
    api_key_hint           text NOT NULL DEFAULT '' CHECK (char_length(api_key_hint) <= 12),

    -- Verification: the last time this address + key actually answered, and what
    -- it answered with. A stored credential that has never been proven is the
    -- state an operator most needs to see.
    verified_at            timestamptz,
    verify_error           text,

    -- The periodic pull that keeps platform_cms_sites fresh, and the event
    -- shipper that feeds OpenObserve. Both default OFF: a deployment with no CMS
    -- must not start making network calls because a migration ran.
    mirror_enabled         boolean NOT NULL DEFAULT false,
    mirror_interval_minutes integer NOT NULL DEFAULT 30
                               CHECK (mirror_interval_minutes BETWEEN 5 AND 1440),
    last_mirror_at         timestamptz,
    last_mirror_error      text,

    log_shipping_enabled   boolean NOT NULL DEFAULT false,
    -- The cursor the event poll resumes from — the newest `at` the shipper has
    -- actually received, never `now()`: a CMS record written while the poll ran
    -- must still be reachable on the next one.
    events_cursor          timestamptz,
    last_events_at         timestamptz,
    last_events_error      text,
    -- Cumulative, for the console's health line. Reset only by an operator.
    events_shipped         bigint NOT NULL DEFAULT 0 CHECK (events_shipped >= 0),

    updated_at             timestamptz NOT NULL DEFAULT now(),
    updated_by             uuid REFERENCES platform_admins(id) ON DELETE SET NULL
);

INSERT INTO platform_cms_config (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- The mirror: last-known-good state of every site on the CMS
-- ---------------------------------------------------------------------------
CREATE TABLE platform_cms_sites (
    -- The CMS's own uuid for the site. Not generated here: this table mirrors,
    -- it does not own, so the identity has to be the CMS's.
    site_id            text PRIMARY KEY CHECK (char_length(trim(site_id)) BETWEEN 1 AND 100),
    domain             text NOT NULL DEFAULT '' CHECK (char_length(domain) <= 255),
    name               text NOT NULL DEFAULT '' CHECK (char_length(name) <= 200),
    site_type          text NOT NULL DEFAULT 'business',
    status             text NOT NULL DEFAULT 'active',
    domain_verified    boolean NOT NULL DEFAULT false,
    default_locale     text NOT NULL DEFAULT 'fa' CHECK (char_length(default_locale) <= 10),
    available_locales  text[] NOT NULL DEFAULT ARRAY[]::text[],
    currency           text CHECK (currency IS NULL OR char_length(currency) <= 10),

    -- The counts the console's table draws, exactly as the CMS reported them.
    pages              integer NOT NULL DEFAULT 0,
    pages_published    integer NOT NULL DEFAULT 0,
    posts              integer NOT NULL DEFAULT 0,
    posts_published    integer NOT NULL DEFAULT 0,
    products           integer NOT NULL DEFAULT 0,
    products_published integer NOT NULL DEFAULT 0,
    categories         integer NOT NULL DEFAULT 0,
    media              integer NOT NULL DEFAULT 0,
    orders             integer NOT NULL DEFAULT 0,
    orders_paid        integer NOT NULL DEFAULT 0,

    -- Aliases and gateway rows as the CMS returned them, kept whole rather than
    -- shredded into tables of their own: this is a cache of somebody else's
    -- model, and normalizing a cache is how it drifts from what it mirrors.
    aliases            jsonb NOT NULL DEFAULT '[]'::jsonb,
    gateways           jsonb NOT NULL DEFAULT '[]'::jsonb,

    -- Which business on THIS platform owns the site, when one does. Resolved by
    -- joining eshobe_cms_connections.site_id, so the console can answer "whose
    -- site is this?" — and left NULL for a site nobody here is billed for, which
    -- is itself a finding worth showing.
    business_id        uuid REFERENCES businesses(id) ON DELETE SET NULL,

    cms_updated_at     timestamptz,
    mirrored_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_platform_cms_sites_domain ON platform_cms_sites (domain);
CREATE INDEX idx_platform_cms_sites_business ON platform_cms_sites (business_id);
CREATE INDEX idx_platform_cms_sites_status ON platform_cms_sites (status, mirrored_at DESC);

-- ---------------------------------------------------------------------------
-- The log: every sync, in either direction
-- ---------------------------------------------------------------------------
CREATE TABLE platform_cms_sync_runs (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- `mirror`   — pull the fleet report and refresh platform_cms_sites
    -- `events`   — poll the CMS event feed and ship it to the log store
    -- `pull`     — export one site's content FROM the CMS
    -- `push`     — apply a snapshot TO the CMS
    kind           text NOT NULL CHECK (kind IN ('mirror', 'events', 'pull', 'push')),
    -- 'scheduled' for the server tick, 'manual' for a console button. A tick
    -- that goes wrong nightly and a button somebody pressed once are different
    -- investigations.
    trigger        text NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'scheduled')),
    site_id        text,
    status         text NOT NULL CHECK (status IN ('ok', 'partial', 'failed')),
    -- Whether this run wrote anything at all — a dry run is a real run of the
    -- plan and must be distinguishable from the apply that followed it.
    dry_run        boolean NOT NULL DEFAULT false,
    items          integer NOT NULL DEFAULT 0 CHECK (items >= 0),
    created        integer NOT NULL DEFAULT 0 CHECK (created >= 0),
    updated        integer NOT NULL DEFAULT 0 CHECK (updated >= 0),
    skipped        integer NOT NULL DEFAULT 0 CHECK (skipped >= 0),
    duration_ms    integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
    error          text,
    detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
    started_by     uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_platform_cms_sync_runs_recent ON platform_cms_sync_runs (created_at DESC);
CREATE INDEX idx_platform_cms_sync_runs_kind ON platform_cms_sync_runs (kind, created_at DESC);
