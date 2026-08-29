-- ============================================================================
-- 0117_knowledge_base.sql — the knowledge base the super-admin maintains.
--
-- One learning page (a URL) per dashboard section. Every important page in
-- the user section carries a «آموزش» icon that opens the stored URL for its
-- section in a modal, so a member can learn the screen they are standing on.
-- The super-admin adds/edits the URL per section in the console
-- (`/platform/knowledge`, `/api/platform/knowledge`).
--
-- A platform catalogue in the `feature_flags`/`plans` shape (see 0021/0034):
-- it holds no business_id — the same pages teach every business — so it has
-- no tenant RLS policy and is exempt in the tenant-isolation test. Tenant
-- routes read it (active rows only, through GET /api/knowledge); it is
-- written only through /api/platform/knowledge under a platform session.
--
-- One entry per section: `section` is unique, so the console upserts and the
-- dashboard's lookup is a single row.
-- ============================================================================

CREATE TABLE knowledge_base_entries (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    section    text NOT NULL UNIQUE,
    url        text NOT NULL CHECK (btrim(url) <> ''),
    is_active  boolean NOT NULL DEFAULT true,
    notes      text NOT NULL DEFAULT '',
    created_by text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
