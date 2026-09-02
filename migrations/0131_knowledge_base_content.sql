-- ============================================================================
-- 0131_knowledge_base_content.sql — the in-product knowledge base.
--
-- Migration 0117 attached one external learning-page URL to each dashboard
-- section. This migration grows the knowledge base into a full content
-- platform maintained from the super-admin console («پایگاه دانش») and read
-- by every member at «مرکز آموزش» (/dashboard/knowledge):
--
--   knowledge_categories    the category builder: nested, orderable sections
--                           the member side menu is built from.
--   knowledge_tags          cross-cutting labels; an article carries any
--                           number of them and the reader can filter by them.
--   knowledge_articles      one article = a markdown body (text, images and
--                           fenced code), an optional video and cover image,
--                           and the list of dashboard sections it teaches
--                           (section_keys), so the «آموزش» icon on a screen
--                           can deep-link to its own in-product guide.
--   knowledge_article_tags  the many-to-many between articles and tags.
--
-- All four are platform catalogues in the `feature_flags`/`plans` shape (see
-- 0021/0034/0117): they hold no business_id — the same article teaches every
-- business — so they carry no tenant RLS policy and are listed as exempt in
-- src/lib/tenant-tables.ts (which the tenant-isolation integration test
-- checks). Writes happen only through /api/platform/knowledge/* under a
-- platform session (`knowledge.manage`); tenant routes read published rows
-- only, through /api/knowledge/*.
--
-- Search is PostgreSQL full-text search over a stored tsvector built with the
-- 'simple' configuration (Persian needs tokenization, not stemming), ranked
-- in src/lib/knowledge-service.ts with exact-match boosts on title/slug.
-- ============================================================================

CREATE TABLE knowledge_categories (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- NULL = a root category. RESTRICT so a category with children cannot be
    -- deleted before its children are moved or removed — the console surfaces
    -- this as a normal message instead of a failed query.
    parent_id   uuid REFERENCES knowledge_categories(id) ON DELETE RESTRICT,
    slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    title       text NOT NULL CHECK (btrim(title) <> ''),
    description text NOT NULL DEFAULT '',
    -- An emoji or a lucide icon name the member side menu and the console
    -- render next to the title; empty means "no icon".
    icon        text NOT NULL DEFAULT '',
    -- Accent key recognised by the UI: amber | emerald | sky | rose | violet
    -- (empty = neutral).
    tone        text NOT NULL DEFAULT '',
    sort_order  integer NOT NULL DEFAULT 0,
    is_active   boolean NOT NULL DEFAULT true,
    created_by  text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX knowledge_categories_parent_idx
    ON knowledge_categories (parent_id, sort_order);

CREATE TABLE knowledge_tags (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    label       text NOT NULL CHECK (btrim(label) <> ''),
    description text NOT NULL DEFAULT '',
    created_by  text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_articles (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug         text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    -- Nullable so a guide can live outside every category («بدون دسته» in the
    -- tree) and so deleting a category never deletes its articles.
    category_id  uuid REFERENCES knowledge_categories(id) ON DELETE SET NULL,
    -- The KNOWLEDGE_SECTIONS keys this article teaches (src/lib/knowledge-base.ts).
    -- An article may cover several screens, and «عمومی» guides cover none.
    section_keys text[] NOT NULL DEFAULT '{}',
    title        text NOT NULL CHECK (btrim(title) <> ''),
    summary      text NOT NULL DEFAULT '',
    body_md      text NOT NULL DEFAULT '',
    -- Optional rich media: a direct video file (.mp4/.webm/… renders a player)
    -- or an embeddable page (Aparat/YouTube render an iframe), plus a cover.
    video_url        text NOT NULL DEFAULT '',
    cover_image_url  text NOT NULL DEFAULT '',
    status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
    sort_order   integer NOT NULL DEFAULT 0,
    published_at timestamptz,
    created_by   text NOT NULL DEFAULT '',
    updated_by   text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Ranking column for /api/knowledge/search. 'simple' tokenises on punctuation
-- and whitespace without stemming — the right behaviour for Persian text.
ALTER TABLE knowledge_articles
    ADD COLUMN search_tsv tsvector
    GENERATED ALWAYS AS (
        to_tsvector(
            'simple',
            coalesce(title, '') || ' ' ||
            coalesce(summary, '') || ' ' ||
            coalesce(body_md, '')
        )
    ) STORED;

CREATE INDEX knowledge_articles_search_idx ON knowledge_articles USING GIN (search_tsv);
CREATE INDEX knowledge_articles_category_idx
    ON knowledge_articles (category_id, status, sort_order, updated_at);
CREATE INDEX knowledge_articles_section_keys_idx ON knowledge_articles USING GIN (section_keys);

CREATE TABLE knowledge_article_tags (
    article_id uuid NOT NULL REFERENCES knowledge_articles(id) ON DELETE CASCADE,
    tag_id     uuid NOT NULL REFERENCES knowledge_tags(id) ON DELETE CASCADE,
    PRIMARY KEY (article_id, tag_id)
);
