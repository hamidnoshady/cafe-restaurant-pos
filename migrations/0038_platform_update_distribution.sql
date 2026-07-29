-- 0038_platform_update_distribution.sql — config for distributing the
-- standalone desktop installer's updates (electron-updater's "generic"
-- provider, pointed at a public-read S3-compatible bucket — see
-- docs/standalone-desktop-app.md). This is platform-wide infrastructure, not
-- any one business's data, so it's a singleton row rather than a per-business
-- settings key — same category as businesses/platform_admins: not
-- tenant-scoped, so no RLS policy applies here (nothing to scope by).
--
-- The `id boolean PRIMARY KEY DEFAULT true CHECK (id)` trick keeps this to
-- exactly one row: any second insert collides on the primary key.
CREATE TABLE platform_update_config (
    id                    boolean PRIMARY KEY DEFAULT true CHECK (id),
    s3_endpoint           text,
    s3_bucket             text,
    s3_access_key_id      text,
    s3_secret_access_key  text,
    public_base_url       text,
    updated_at            timestamptz NOT NULL DEFAULT now()
);
