-- ============================================================================
-- 0149_media_library.sql — «کتابخانهٔ رسانه»: the platform-wide media section.
--
-- One shared library per business for images, videos and documents, organized
-- with visual folders and categories/tags, stored in the S3-compatible object
-- storage (Parspack et al.) the super-admin configures for the whole
-- deployment. Five pieces:
--
--   1. `platform_media_config` — the deployment-wide singleton the console
--      edits, in exactly the shape of `platform_backup_config` (0132) /
--      `platform_payment_config` (0130): the one S3 connection every tenant's
--      media lands in (endpoint, region, bucket, key prefix, credentials) and
--      the storage price policy — a flat daily fee plus a per-GB daily rate
--      with a free quota, both in integer Rial like every other price on the
--      platform. No business_id: it belongs to the deployment, so it is
--      deliberately outside RLS and listed in EXEMPT_TABLES
--      (src/lib/tenant-tables.ts).
--
--      Tenant isolation inside that ONE bucket is a *key-prefix* rule, not a
--      bucket-per-tenant rule: every object key is
--      `{prefix}{business_id}/{asset_id}/{file}`, the key is always BUILT from
--      the caller's tenant scope (never accepted from a request), and the
--      pure half (src/lib/media.ts, unit-tested) refuses any key that does
--      not sit under the owning business's prefix. The database row is what
--      RLS protects; the object is reachable only through that row.
--
--   2. `media_folders` — the visual folder tree. Self-referencing parent_id,
--      per business, so «تصاویر منو / نوشیدنی‌ها» is a path the UI can walk.
--      Deleting a folder re-parents nothing implicitly: children cascade with
--      it, and assets in it fall back to the root (SET NULL) rather than
--      vanishing — a folder is an arrangement, never the custody of a file.
--
--   3. `media_assets` — one row per stored object: kind (image/video/
--      document), the original file name, MIME type (verified against byte
--      signatures at upload — src/lib/media.ts), byte size, the storage key,
--      sha256 of the bytes, the user-facing organization (folder, category,
--      tags[]), and the AI half: `ai_labels` holds the model's *proposed*
--      tags/category and `ai_status` records whether the operator has
--      confirmed them ('pending_review') into the real columns ('confirmed')
--      or rejected them — auto-tagging never applies itself, per the product
--      rule that AI proposals require user confirmation.
--
--      `variant`/`source_asset_id` record the optional AI refine step: the
--      enhanced, white-background, centered product shot is a NEW asset row
--      ('enhanced') pointing back at its original, so the standard website
--      product image never overwrites the photo it came from.
--
--   4. `media_usage_charges` — the idempotency ledger for the daily storage
--      charge, in exactly the shape of `website_service_charges` (0138): one
--      row per business per local day, claimed ON CONFLICT DO NOTHING before
--      any money moves, so a retried tick can never bill the same day twice.
--      The actual debit is `chargeFeatureUse` on the business wallet — the
--      single payment system every platform function spends from.
--
--   5. Item images: `menu_items.image_media_id` and
--      `inventory_items.image_media_id` — the catalogue item's canonical
--      photo, chosen from (or uploaded into) the library. The inventory one
--      is what the visual stock counter shows as the exemplar reference for
--      the item being counted.
--
-- Tenancy: the three tenant tables carry business_id and get their RLS policy
-- in this same migration, per the repo convention (src/lib/db.ts).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- The deployment-wide media/object-storage configuration (one row)
-- ---------------------------------------------------------------------------
CREATE TABLE platform_media_config (
    id                    boolean PRIMARY KEY DEFAULT true CHECK (id),

    -- Master switch: uploads and reads refuse politely until the console has
    -- pointed the platform at a bucket.
    enabled               boolean NOT NULL DEFAULT false,

    -- The S3-compatible connection (Parspack, ArvanCloud, MinIO, AWS …),
    -- path-style, same client as backups (src/lib/s3-lite.ts).
    endpoint              text NOT NULL DEFAULT '',
    region                text NOT NULL DEFAULT 'us-east-1',
    bucket                text NOT NULL DEFAULT '',
    -- Object key prefix, normalized to end with '/' (empty = bucket root).
    -- Defaults apart from the backup prefixes so one shared bucket cannot
    -- collide with either backup half.
    key_prefix            text NOT NULL DEFAULT 'media/',
    access_key_id         text NOT NULL DEFAULT '',
    secret_access_key     text NOT NULL DEFAULT '',

    -- Storage price policy: what using the library costs a business per local
    -- day, decremented from its platform wallet by the daily tick.
    --   flat  — a base fee for any business that stores anything at all;
    --   perGB — pro-rated to the bytes actually stored above the free quota.
    -- Zero everywhere = the library is free (rows are still written so the
    -- console can see usage).
    billing_enabled       boolean NOT NULL DEFAULT false,
    daily_flat_rial       bigint NOT NULL DEFAULT 0 CHECK (daily_flat_rial >= 0),
    daily_per_gb_rial     bigint NOT NULL DEFAULT 0 CHECK (daily_per_gb_rial >= 0),
    free_quota_mb         integer NOT NULL DEFAULT 0 CHECK (free_quota_mb >= 0),

    -- The optional AI product-image refine step: which image-edit model the
    -- provider call names, and what one refine costs the business.
    enhance_model         text NOT NULL DEFAULT 'gpt-image-1',
    enhance_price_rial    bigint NOT NULL DEFAULT 0 CHECK (enhance_price_rial >= 0),

    updated_by            uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    updated_at            timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform_media_config (id) VALUES (true);

-- ---------------------------------------------------------------------------
-- Folders — the visual tree a business arranges its library with
-- ---------------------------------------------------------------------------
CREATE TABLE media_folders (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    parent_id   uuid REFERENCES media_folders(id) ON DELETE CASCADE,
    name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    -- Two «نوشیدنی‌ها» beside each other in one place helps nobody; NULLs are
    -- distinct in a UNIQUE index, so root-level names get their own index below.
    UNIQUE (business_id, parent_id, name)
);
CREATE UNIQUE INDEX idx_media_folders_root_name
    ON media_folders (business_id, name) WHERE parent_id IS NULL;
CREATE INDEX idx_media_folders_parent ON media_folders (parent_id);

ALTER TABLE media_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_folders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON media_folders FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- Assets — one row per stored object
-- ---------------------------------------------------------------------------
CREATE TABLE media_assets (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    folder_id       uuid REFERENCES media_folders(id) ON DELETE SET NULL,
    kind            text NOT NULL CHECK (kind IN ('image', 'video', 'document')),
    file_name       text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200),
    mime_type       text NOT NULL,
    byte_size       bigint NOT NULL CHECK (byte_size > 0),
    -- `{prefix}{business_id}/{asset_id}/{file}` — always built server-side
    -- from the tenant scope, never accepted from a request (src/lib/media.ts).
    storage_key     text NOT NULL,
    sha256          text NOT NULL,

    -- User-facing organization. Category is one label; tags are many.
    category        text CHECK (category IS NULL OR char_length(category) <= 80),
    tags            text[] NOT NULL DEFAULT '{}',

    -- The AI proposal, awaiting the operator: [{"tag": "...", ...}] plus a
    -- proposed category, exactly as the model returned it (clamped/parsed by
    -- src/lib/ai-media.ts). Applied to `category`/`tags` only on confirm.
    ai_labels       jsonb NOT NULL DEFAULT '{}'::jsonb,
    ai_status       text NOT NULL DEFAULT 'none'
                        CHECK (ai_status IN ('none', 'pending_review', 'confirmed', 'rejected')),

    -- The optional refine pipeline: an 'enhanced' asset is the standard
    -- white-background product shot generated FROM source_asset_id.
    variant         text NOT NULL DEFAULT 'original'
                        CHECK (variant IN ('original', 'enhanced')),
    source_asset_id uuid REFERENCES media_assets(id) ON DELETE SET NULL,

    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_media_assets_business_created ON media_assets (business_id, created_at DESC);
CREATE INDEX idx_media_assets_folder ON media_assets (folder_id);
CREATE INDEX idx_media_assets_kind ON media_assets (business_id, kind);
CREATE INDEX idx_media_assets_tags ON media_assets USING gin (tags);

ALTER TABLE media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON media_assets FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- The daily storage charge's idempotency ledger (shape of website_service_charges)
-- ---------------------------------------------------------------------------
CREATE TABLE media_usage_charges (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- The local (Asia/Tehran wall-clock) day this charge covers, as
    -- YYYY-MM-DD. One claim per business per day, whatever the tick count.
    day           text NOT NULL CHECK (day ~ '^\d{4}-\d{2}-\d{2}$'),
    stored_bytes  bigint NOT NULL CHECK (stored_bytes >= 0),
    flat_rial     bigint NOT NULL DEFAULT 0 CHECK (flat_rial >= 0),
    per_gb_rial   bigint NOT NULL DEFAULT 0 CHECK (per_gb_rial >= 0),
    amount_rial   bigint NOT NULL CHECK (amount_rial >= 0),
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, day)
);
CREATE INDEX idx_media_usage_charges_business ON media_usage_charges (business_id, day DESC);

ALTER TABLE media_usage_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_usage_charges FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON media_usage_charges FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- Item images — the catalogue photo, chosen from the library
-- ---------------------------------------------------------------------------
ALTER TABLE menu_items
    ADD COLUMN IF NOT EXISTS image_media_id uuid REFERENCES media_assets(id) ON DELETE SET NULL;
ALTER TABLE inventory_items
    ADD COLUMN IF NOT EXISTS image_media_id uuid REFERENCES media_assets(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- The wallet's feature keys (wallet_ledger.feature_key → feature_flags.key)
-- ---------------------------------------------------------------------------
INSERT INTO feature_flags (key, name, description, default_enabled) VALUES
    ('media_storage', 'فضای ذخیره‌سازی رسانه',
     'کتابخانهٔ رسانه: نگهداری تصاویر، ویدیوها و اسناد کسب‌وکار در فضای ابری با هزینهٔ روزانه',
     true),
    ('media_enhance', 'بهینه‌سازی تصویر محصول با هوش مصنوعی',
     'اصلاح تصویر محصول به استاندارد سایت: پس‌زمینهٔ سفید، سوژهٔ وسط کادر و ترازبندی یکنواخت',
     true)
ON CONFLICT (key) DO NOTHING;
