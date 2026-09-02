/**
 * The in-product knowledge base — the database half.
 *
 * The four tables of migration 0131 (knowledge_categories, knowledge_tags,
 * knowledge_articles, knowledge_article_tags) are platform catalogues: no
 * business_id, one body of content that teaches every business. That makes
 * this service usable from both realms exactly the way knowledge-base.ts and
 * its 0117 store are:
 *
 *  - the tenant realm (`/api/knowledge/*`, already tenant-scoped by
 *    `withTenantScope`) reads **published** rows only through the `listKb*`
 *    functions — members learn; they never see drafts;
 *  - the platform realm (`/api/platform/knowledge/*`, guarded by
 *    `knowledge.manage`) writes through the `admin*` functions.
 *
 * Search runs on the stored `search_tsv` tsvector ('simple' config — Persian
 * wants tokenization, not stemming) with exact-match boosts on slug/title so
 * typing an article's exact words beats a incidental full-text hit.
 */
import { query } from "./db";
import {
  buildKbCategoryTree,
  isKbSlug,
  kbSnippet,
  kbVideoKind,
  normalizeSectionKeys,
  parseHttpUrl,
  stripMarkdown,
  type KbArticleDetail,
  type KbArticleListItem,
  type KbCategoryFlat,
  type KbSearchHit,
  type KbTagRef,
} from "./knowledge";
import type { KbVideoKind } from "./knowledge";

// ---------------------------------------------------------------------------
// Shared row shapes and mappers
// ---------------------------------------------------------------------------

type CategoryRow = {
  id: string;
  parent_id: string | null;
  slug: string;
  title: string;
  description: string;
  icon: string;
  tone: string;
  sort_order: number;
  is_active?: boolean;
  article_count?: string | number | null;
};

type ArticleRow = {
  id: string;
  slug: string;
  category_id: string | null;
  section_keys: string[];
  title: string;
  summary: string;
  status?: string;
  body_md?: string;
  video_url?: string;
  cover_image_url?: string;
  sort_order: number;
  published_at?: string | null;
  created_at?: string;
  updated_at: string;
};

type TagRow = {
  id: string;
  slug: string;
  label: string;
  description?: string;
  article_count?: string | number | null;
};

export interface KbCategoryRecord extends KbCategoryFlat {
  isActive: boolean;
  articleCount: number;
}

export interface KbTagRecord extends KbTagRef {
  id: string;
  description: string;
  articleCount: number;
}

export interface KbArticleRecord {
  id: string;
  slug: string;
  categoryId: string | null;
  sectionKeys: string[];
  title: string;
  summary: string;
  bodyMd: string;
  videoUrl: string;
  coverImageUrl: string;
  status: "draft" | "published";
  sortOrder: number;
  tagIds: string[];
  tagRefs: KbTagRef[];
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapCategory(row: CategoryRow): KbCategoryRecord {
  return {
    id: row.id,
    parentId: row.parent_id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    icon: row.icon,
    tone: row.tone,
    sortOrder: row.sort_order,
    isActive: row.is_active ?? true,
    articleCount: Number(row.article_count ?? 0),
  };
}

function mapTag(row: TagRow): KbTagRecord {
  return {
    id: row.id,
    slug: row.slug,
    label: row.label,
    description: row.description ?? "",
    articleCount: Number(row.article_count ?? 0),
  };
}

function mapArticleListItem(
  row: ArticleRow,
  tagRefs: KbTagRef[],
): KbArticleListItem {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    categoryId: row.category_id,
    sectionKeys: row.section_keys ?? [],
    tags: tagRefs,
    hasVideo: Boolean(row.video_url),
    hasCover: Boolean(row.cover_image_url),
    sortOrder: row.sort_order,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Errors the routes translate into response codes
// ---------------------------------------------------------------------------

export class KnowledgeServiceError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Member reads (published only)
// ---------------------------------------------------------------------------

/** Everything «مرکز آموزش» needs for its side menu, cards and tag filter. */
export async function listKbCatalogue(): Promise<{
  categories: KbCategoryFlat[];
  articles: KbArticleListItem[];
  tags: KbTagRef[];
}> {
  const [{ rows: categories }, { rows: articles }, { rows: tags }, { rows: tagLinks }] =
    await Promise.all([
      query<CategoryRow & { is_active: boolean }>(
        `SELECT c.id, c.parent_id, c.slug, c.title, c.description, c.icon, c.tone,
                c.sort_order,
                (SELECT count(*) FROM knowledge_articles a
                  WHERE a.category_id = c.id AND a.status = 'published') AS article_count
           FROM knowledge_categories c
          WHERE c.is_active = true`,
      ),
      query<ArticleRow>(
        `SELECT id, slug, category_id, section_keys, title, summary,
                video_url, cover_image_url, sort_order, updated_at
           FROM knowledge_articles
          WHERE status = 'published'`,
      ),
      query<TagRow>(
        `SELECT DISTINCT t.slug, t.label
           FROM knowledge_tags t
           JOIN knowledge_article_tags at ON at.tag_id = t.id
           JOIN knowledge_articles a ON a.id = at.article_id AND a.status = 'published'`,
      ),
      query<{ article_id: string; slug: string; label: string }>(
        `SELECT at.article_id, t.slug, t.label
           FROM knowledge_article_tags at
           JOIN knowledge_tags t ON t.id = at.tag_id
           JOIN knowledge_articles a ON a.id = at.article_id AND a.status = 'published'`,
      ),
    ]);

  const tagsByArticle = new Map<string, KbTagRef[]>();
  for (const link of tagLinks) {
    const list = tagsByArticle.get(link.article_id) ?? [];
    list.push({ slug: link.slug, label: link.label });
    tagsByArticle.set(link.article_id, list);
  }

  return {
    categories: categories.map((row) => mapCategory({ ...row, is_active: true })),
    articles: articles
      .map((row) => mapArticleListItem(row, tagsByArticle.get(row.id) ?? []))
      .sort(
        (a, b) =>
          (a.categoryId ?? "").localeCompare(b.categoryId ?? "") ||
          a.sortOrder - b.sortOrder ||
          b.updatedAt.localeCompare(a.updatedAt),
      ),
    tags: tags.map((t) => ({ slug: t.slug, label: t.label })),
  };
}

/** One published article plus its related reads (same category or a shared section). */
export async function getKbArticleBySlug(slug: string): Promise<KbArticleDetail | null> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slug);
  const { rows } = await query<ArticleRow>(
    `SELECT id, slug, category_id, section_keys, title, summary, body_md,
            video_url, cover_image_url, sort_order, published_at, updated_at
       FROM knowledge_articles
      WHERE status = 'published'
        AND (slug = $1 ${isUuid ? "OR id = $1::uuid" : ""})
      LIMIT 1`,
    [slug],
  );
  const row = rows[0];
  if (!row) return null;

  const [{ rows: tagRows }, { rows: relatedRows }] = await Promise.all([
    query<TagRow>(
      `SELECT t.slug, t.label
         FROM knowledge_article_tags at
         JOIN knowledge_tags t ON t.id = at.tag_id
        WHERE at.article_id = $1
        ORDER BY t.slug`,
      [row.id],
    ),
    query<ArticleRow>(
      `SELECT id, slug, category_id, section_keys, title, summary,
              video_url, cover_image_url, sort_order, updated_at
         FROM knowledge_articles
        WHERE status = 'published'
          AND id <> $1
          AND (category_id = $2 OR section_keys && $3::text[])
        ORDER BY sort_order, updated_at DESC
        LIMIT 6`,
      [row.id, row.category_id, row.section_keys ?? []],
    ),
  ]);

  const tagRefs = tagRows.map((t) => ({ slug: t.slug, label: t.label }));
  const relatedTagIds = relatedRows.map((r) => r.id);
  const { rows: relatedTagRows } = relatedTagIds.length
    ? await query<{ article_id: string; slug: string; label: string }>(
        `SELECT at.article_id, t.slug, t.label
           FROM knowledge_article_tags at
           JOIN knowledge_tags t ON t.id = at.tag_id
          WHERE at.article_id = ANY($1::uuid[])`,
        [relatedTagIds],
      )
    : { rows: [] as { article_id: string; slug: string; label: string }[] };
  const relatedTagsByArticle = new Map<string, KbTagRef[]>();
  for (const link of relatedTagRows) {
    const list = relatedTagsByArticle.get(link.article_id) ?? [];
    list.push({ slug: link.slug, label: link.label });
    relatedTagsByArticle.set(link.article_id, list);
  }

  const videoKind: KbVideoKind | null = row.video_url ? kbVideoKind(row.video_url) : null;
  return {
    ...mapArticleListItem(row, tagRefs),
    bodyMd: row.body_md ?? "",
    videoUrl: row.video_url ?? "",
    videoKind,
    coverImageUrl: row.cover_image_url ?? "",
    publishedAt: row.published_at ?? null,
    related: relatedRows.map((r) =>
      mapArticleListItem(r, relatedTagsByArticle.get(r.id) ?? []),
    ),
  };
}

/** Ranked full-text search over published articles (title/summary weighted up). */
export async function searchKbArticles(rawQuery: string, limit = 20): Promise<KbSearchHit[]> {
  const q = rawQuery.trim();
  if (!q) return [];
  const { rows } = await query<
    ArticleRow & { category_title: string | null; tag_slugs: string[] | null; rank: number }
  >(
    `WITH terms AS (
       SELECT websearch_to_tsquery('simple', $1) AS tq
     )
     SELECT a.id, a.slug, a.category_id, a.section_keys, a.title, a.summary,
            a.video_url, a.cover_image_url, a.sort_order, a.updated_at,
            a.body_md,
            c.title AS category_title,
            (SELECT coalesce(array_agg(jsonb_build_object('slug', t.slug, 'label', t.label)), '{}')
               FROM knowledge_article_tags at JOIN knowledge_tags t ON t.id = at.tag_id
              WHERE at.article_id = a.id) AS tag_slugs,
            (ts_rank(a.search_tsv, terms.tq)
             + (a.title ILIKE '%' || $1 || '%')::int * 2
             + (a.slug ILIKE '%' || $1 || '%')::int * 1.5
             + (a.summary ILIKE '%' || $1 || '%')::int) AS rank
       FROM knowledge_articles a
       LEFT JOIN knowledge_categories c ON c.id = a.category_id
       CROSS JOIN terms
      WHERE a.status = 'published'
        AND (a.search_tsv @@ terms.tq
             OR a.title ILIKE '%' || $1 || '%'
             OR a.summary ILIKE '%' || $1 || '%'
             OR a.slug ILIKE '%' || $1 || '%')
      ORDER BY rank DESC, a.updated_at DESC
      LIMIT $2`,
    [q, Math.min(Math.max(limit, 1), 50)],
  );

  return rows.map((row) => {
    const bodyText = stripMarkdown(row.body_md ?? "");
    const snippetSource = row.summary || bodyText;
    const tags = Array.isArray(row.tag_slugs)
      ? (row.tag_slugs as unknown as KbTagRef[])
      : [];
    return {
      slug: row.slug,
      title: row.title,
      summary: row.summary,
      snippet: kbSnippet(snippetSource, q),
      categoryTitle: row.category_title,
      tags,
      updatedAt: row.updated_at,
    };
  });
}

/** The newest published articles — the home page's «به‌روزترین‌ها». */
export async function listKbLatest(limit = 6): Promise<KbArticleListItem[]> {
  const { rows } = await query<ArticleRow>(
    `SELECT id, slug, category_id, section_keys, title, summary,
            video_url, cover_image_url, sort_order, updated_at
       FROM knowledge_articles
      WHERE status = 'published'
      ORDER BY published_at DESC NULLS LAST, updated_at DESC
      LIMIT $1`,
    [Math.min(Math.max(limit, 1), 24)],
  );
  return rows.map((row) => mapArticleListItem(row, []));
}

/**
 * One learning guide per dashboard section — the «آموزش» icon's deep link.
 * Picks the article that claims the section, preferring its own ordering.
 */
export async function kbGuideForSection(
  sectionKey: string,
): Promise<{ slug: string; title: string } | null> {
  const { rows } = await query<{ slug: string; title: string }>(
    `SELECT slug, title
       FROM knowledge_articles
      WHERE status = 'published' AND $1 = ANY(section_keys)
      ORDER BY sort_order, updated_at DESC
      LIMIT 1`,
    [sectionKey],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Platform writes (categories — the console's «دسته‌ساز»)
// ---------------------------------------------------------------------------

export interface KbCategoryInput {
  slug: string;
  title: string;
  description: string;
  icon: string;
  tone: string;
  parentId: string | null;
  sortOrder: number;
  isActive: boolean;
}

/** Every category with its published-or-draft article count, for the builder. */
export async function adminListKbCategories(): Promise<KbCategoryRecord[]> {
  const { rows } = await query<CategoryRow>(
    `SELECT c.id, c.parent_id, c.slug, c.title, c.description, c.icon, c.tone,
            c.sort_order, c.is_active,
            (SELECT count(*) FROM knowledge_articles a WHERE a.category_id = c.id) AS article_count
       FROM knowledge_categories c`,
  );
  return rows.map(mapCategory);
}

export async function adminCreateKbCategory(input: KbCategoryInput, actor: string): Promise<string> {
  await assertKbParent(input.parentId, null);
  const { rows } = await query<{ id: string }>(
    `INSERT INTO knowledge_categories
       (parent_id, slug, title, description, icon, tone, sort_order, is_active, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      input.parentId,
      input.slug,
      input.title,
      input.description,
      input.icon,
      input.tone,
      input.sortOrder,
      input.isActive,
      actor,
    ],
  );
  return rows[0].id;
}

export async function adminUpdateKbCategory(
  id: string,
  input: KbCategoryInput,
): Promise<void> {
  await assertKbParent(input.parentId, id);
  const { rowCount } = await query(
    `UPDATE knowledge_categories
        SET parent_id = $2, slug = $3, title = $4, description = $5, icon = $6,
            tone = $7, sort_order = $8, is_active = $9, updated_at = now()
      WHERE id = $1`,
    [
      id,
      input.parentId,
      input.slug,
      input.title,
      input.description,
      input.icon,
      input.tone,
      input.sortOrder,
      input.isActive,
    ],
  );
  if (!rowCount) throw new KnowledgeServiceError("not_found");
}

/** Deleting is refused while children or articles still point at the category. */
export async function adminDeleteKbCategory(id: string): Promise<void> {
  const { rowCount: children } = await query(
    "SELECT 1 FROM knowledge_categories WHERE parent_id = $1 LIMIT 1",
    [id],
  );
  if (children) throw new KnowledgeServiceError("category_has_children");
  const { rowCount: articles } = await query(
    "SELECT 1 FROM knowledge_articles WHERE category_id = $1 LIMIT 1",
    [id],
  );
  if (articles) throw new KnowledgeServiceError("category_has_articles");
  const { rowCount } = await query("DELETE FROM knowledge_categories WHERE id = $1", [id]);
  if (!rowCount) throw new KnowledgeServiceError("not_found");
}

/** A parent must exist and must not be the category itself (cycles end there). */
async function assertKbParent(parentId: string | null, selfId: string | null): Promise<void> {
  if (!parentId) return;
  if (selfId && parentId === selfId) throw new KnowledgeServiceError("category_cycle");
  const { rowCount } = await query("SELECT 1 FROM knowledge_categories WHERE id = $1", [parentId]);
  if (!rowCount) throw new KnowledgeServiceError("parent_not_found");
}

// ---------------------------------------------------------------------------
// Platform writes (tags)
// ---------------------------------------------------------------------------

export async function adminListKbTags(): Promise<KbTagRecord[]> {
  const { rows } = await query<TagRow>(
    `SELECT t.id, t.slug, t.label, t.description,
            (SELECT count(*) FROM knowledge_article_tags at WHERE at.tag_id = t.id) AS article_count
       FROM knowledge_tags t
      ORDER BY t.slug`,
  );
  return rows.map(mapTag);
}

export interface KbTagInput {
  slug: string;
  label: string;
  description: string;
}

export async function adminCreateKbTag(input: KbTagInput, actor: string): Promise<string> {
  const { rows } = await query<{ id: string }>(
    "INSERT INTO knowledge_tags (slug, label, description, created_by) VALUES ($1, $2, $3, $4) RETURNING id",
    [input.slug, input.label, input.description, actor],
  );
  return rows[0].id;
}

export async function adminUpdateKbTag(id: string, input: KbTagInput): Promise<void> {
  const { rowCount } = await query(
    "UPDATE knowledge_tags SET slug = $2, label = $3, description = $4 WHERE id = $1",
    [id, input.slug, input.label, input.description],
  );
  if (!rowCount) throw new KnowledgeServiceError("not_found");
}

/** Deleting a tag only un-links it — articles themselves are untouched. */
export async function adminDeleteKbTag(id: string): Promise<void> {
  const { rowCount } = await query("DELETE FROM knowledge_tags WHERE id = $1", [id]);
  if (!rowCount) throw new KnowledgeServiceError("not_found");
}

// ---------------------------------------------------------------------------
// Platform writes (articles)
// ---------------------------------------------------------------------------

export interface KbArticleInput {
  slug: string;
  categoryId: string | null;
  sectionKeys: string[];
  title: string;
  summary: string;
  bodyMd: string;
  videoUrl: string;
  coverImageUrl: string;
  status: "draft" | "published";
  sortOrder: number;
  tagIds: string[];
}

export interface KbArticleFilters {
  q?: string;
  status?: "draft" | "published";
  categoryId?: string;
  section?: string;
  tagId?: string;
}

export async function adminListKbArticles(filters: KbArticleFilters): Promise<KbArticleRecord[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace("$?", `$${params.length}`));
  };
  if (filters.q) {
    const p = params.length + 1;
    params.push(`%${filters.q}%`);
    where.push(`(a.title ILIKE $${p} OR a.slug ILIKE $${p} OR a.summary ILIKE $${p})`);
  }
  if (filters.status === "draft" || filters.status === "published") {
    add("a.status = $?", filters.status);
  }
  if (filters.categoryId) add("a.category_id = $?::uuid", filters.categoryId);
  if (filters.section) add("$? = ANY(a.section_keys)", filters.section);
  if (filters.tagId) {
    add(
      "EXISTS (SELECT 1 FROM knowledge_article_tags at WHERE at.article_id = a.id AND at.tag_id = $?::uuid)",
      filters.tagId,
    );
  }

  const { rows } = await query<ArticleRow & { tag_ids: string[] | null }>(
    `SELECT a.id, a.slug, a.category_id, a.section_keys, a.title, a.summary,
            a.body_md, a.video_url, a.cover_image_url, a.status, a.sort_order,
            a.published_at, a.created_at, a.updated_at,
            (SELECT coalesce(array_agg(at.tag_id), '{}') FROM knowledge_article_tags at
              WHERE at.article_id = a.id) AS tag_ids
       FROM knowledge_articles a
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY a.updated_at DESC
      LIMIT 200`,
    params,
  );
  return rows.map(mapArticleRecord);
}

export async function adminGetKbArticle(id: string): Promise<KbArticleRecord | null> {
  const { rows } = await query<ArticleRow & { tag_ids: string[] | null }>(
    `SELECT a.id, a.slug, a.category_id, a.section_keys, a.title, a.summary,
            a.body_md, a.video_url, a.cover_image_url, a.status, a.sort_order,
            a.published_at, a.created_at, a.updated_at,
            (SELECT coalesce(array_agg(at.tag_id), '{}') FROM knowledge_article_tags at
              WHERE at.article_id = a.id) AS tag_ids
       FROM knowledge_articles a WHERE a.id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ? mapArticleRecord(rows[0]) : null;
}

function mapArticleRecord(row: ArticleRow & { tag_ids: string[] | null }): KbArticleRecord {
  const rawIds = Array.isArray(row.tag_ids) ? row.tag_ids : [];
  return {
    id: row.id,
    slug: row.slug,
    categoryId: row.category_id,
    sectionKeys: row.section_keys ?? [],
    title: row.title,
    summary: row.summary,
    bodyMd: row.body_md ?? "",
    videoUrl: row.video_url ?? "",
    coverImageUrl: row.cover_image_url ?? "",
    status: row.status === "published" ? "published" : "draft",
    sortOrder: row.sort_order,
    tagIds: rawIds.map(String),
    tagRefs: [],
    publishedAt: row.published_at ?? null,
    createdAt: row.created_at ?? row.updated_at,
    updatedAt: row.updated_at,
  };
}

export async function adminCreateKbArticle(input: KbArticleInput, actor: string): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO knowledge_articles
       (slug, category_id, section_keys, title, summary, body_md, video_url,
        cover_image_url, status, sort_order, published_at, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             CASE WHEN $9 = 'published' THEN now() ELSE NULL END, $11, $11)
     RETURNING id`,
    [
      input.slug,
      input.categoryId,
      input.sectionKeys,
      input.title,
      input.summary,
      input.bodyMd,
      input.videoUrl,
      input.coverImageUrl,
      input.status,
      input.sortOrder,
      actor,
    ],
  );
  await replaceArticleTags(rows[0].id, input.tagIds);
  return rows[0].id;
}

export async function adminUpdateKbArticle(id: string, input: KbArticleInput, actor: string): Promise<void> {
  // published_at records the first publish only; later republishes leave it.
  const { rowCount } = await query(
    `UPDATE knowledge_articles
        SET slug = $2, category_id = $3, section_keys = $4, title = $5, summary = $6,
            body_md = $7, video_url = $8, cover_image_url = $9, status = $10,
            sort_order = $11, updated_by = $12, updated_at = now(),
            published_at = CASE
              WHEN $10 = 'published' THEN coalesce(published_at, now())
              ELSE published_at END
      WHERE id = $1`,
    [
      id,
      input.slug,
      input.categoryId,
      input.sectionKeys,
      input.title,
      input.summary,
      input.bodyMd,
      input.videoUrl,
      input.coverImageUrl,
      input.status,
      input.sortOrder,
      actor,
    ],
  );
  if (!rowCount) throw new KnowledgeServiceError("not_found");
  await replaceArticleTags(id, input.tagIds);
}

export async function adminDeleteKbArticle(id: string): Promise<void> {
  const { rowCount } = await query("DELETE FROM knowledge_articles WHERE id = $1", [id]);
  if (!rowCount) throw new KnowledgeServiceError("not_found");
}

async function replaceArticleTags(articleId: string, tagIds: string[]): Promise<void> {
  await query("DELETE FROM knowledge_article_tags WHERE article_id = $1", [articleId]);
  for (const tagId of tagIds) {
    await query(
      "INSERT INTO knowledge_article_tags (article_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [articleId, tagId],
    );
  }
}

/** Re-exported: the console and member tree UIs share the same nesting rules. */
export { buildKbCategoryTree };

// ---------------------------------------------------------------------------
// Request parsing + error mapping shared by the platform knowledge routes
// (kept out of route.ts files, which may only export HTTP method handlers)
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server";

export function parseCategoryInput(raw: unknown):
  | { ok: true; input: KbCategoryInput }
  | { ok: false; error: string } {
  const body = (raw ?? {}) as Record<string, unknown>;
  const str = (key: string, max: number) =>
    typeof body[key] === "string" ? (body[key] as string).trim().slice(0, max) : "";

  const slug = str("slug", 120).toLowerCase();
  if (!isKbSlug(slug)) return { ok: false, error: "invalid_slug" };
  const title = str("title", 200);
  if (!title) return { ok: false, error: "missing_title" };
  const parentRaw = typeof body.parentId === "string" ? body.parentId.trim() : "";
  return {
    ok: true,
    input: {
      slug,
      title,
      description: str("description", 1000),
      icon: str("icon", 40),
      tone: str("tone", 20),
      parentId: parentRaw || null,
      sortOrder:
        typeof body.sortOrder === "number" && Number.isFinite(body.sortOrder)
          ? Math.trunc(body.sortOrder)
          : 0,
      isActive: body.isActive !== false,
    },
  };
}

export function parseTagInput(raw: unknown): { ok: true; input: KbTagInput } | { ok: false; error: string } {
  const body = (raw ?? {}) as Record<string, unknown>;
  const str = (key: string, max: number) =>
    typeof body[key] === "string" ? (body[key] as string).trim().slice(0, max) : "";
  const slug = str("slug", 120).toLowerCase();
  if (!isKbSlug(slug)) return { ok: false, error: "invalid_slug" };
  const label = str("label", 200);
  if (!label) return { ok: false, error: "missing_label" };
  return { ok: true, input: { slug, label, description: str("description", 500) } };
}

export function parseArticleInput(
  raw: unknown,
  knownSectionKeys: ReadonlySet<string>,
): { ok: true; input: KbArticleInput } | { ok: false; error: string } {
  const body = (raw ?? {}) as Record<string, unknown>;
  const str = (key: string, max: number) =>
    typeof body[key] === "string" ? (body[key] as string).trim().slice(0, max) : "";

  const slug = str("slug", 160).toLowerCase();
  if (!isKbSlug(slug)) return { ok: false, error: "invalid_slug" };
  const title = str("title", 300);
  if (!title) return { ok: false, error: "missing_title" };

  const videoUrl = str("videoUrl", 2000);
  const coverImageUrl = str("coverImageUrl", 2000);
  if (videoUrl && !kbVideoKind(videoUrl)) return { ok: false, error: "invalid_video_url" };
  if (coverImageUrl && !parseHttpUrl(coverImageUrl)) {
    return { ok: false, error: "invalid_cover_url" };
  }

  const categoryId = str("categoryId", 64) || null;
  const status = body.status === "published" ? ("published" as const) : ("draft" as const);
  const tagIds = Array.isArray(body.tagIds)
    ? [...new Set(body.tagIds.filter((t): t is string => typeof t === "string"))]
    : [];

  return {
    ok: true,
    input: {
      slug,
      categoryId,
      sectionKeys: normalizeSectionKeys(body.sectionKeys, knownSectionKeys),
      title,
      summary: str("summary", 1000),
      bodyMd: typeof body.bodyMd === "string" ? body.bodyMd.slice(0, 200_000) : "",
      videoUrl,
      coverImageUrl,
      status,
      sortOrder:
        typeof body.sortOrder === "number" && Number.isFinite(body.sortOrder)
          ? Math.trunc(body.sortOrder)
          : 0,
      tagIds,
    },
  };
}

/** Map a service error (or a Postgres unique violation) to an API response. */
export function knowledgeError(err: unknown): NextResponse {
  if (err instanceof KnowledgeServiceError) {
    const status =
      err.code === "not_found" || err.code === "parent_not_found" ? 404 : 409;
    return NextResponse.json({ error: err.code }, { status });
  }
  if (typeof err === "object" && err && (err as { code?: string }).code === "23505") {
    return NextResponse.json({ error: "slug_taken" }, { status: 409 });
  }
  console.error("knowledge route failed", err);
  return NextResponse.json({ error: "unexpected" }, { status: 500 });
}
