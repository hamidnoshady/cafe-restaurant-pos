/**
 * Seeds the in-product knowledge base (migration 0131): the category tree,
 * the tag set and ~45 Persian guides covering every member-facing corner of
 * the platform (the super-admin console is deliberately not documented here).
 *
 * Idempotent: upserts by slug, so re-running refreshes the content rather
 * than duplicating it. Article bodies live in ./knowledge-seed/articles/*.md;
 * metadata in ./knowledge-seed/content.ts.
 *
 * Rows created by this script are marked created_by = 'seed:knowledge' so the
 * console can tell seeded content from hand-written guides (and both can be
 * edited or unpublished afterwards — they are ordinary catalogue rows).
 *
 * Usage: npm run db:seed-knowledge
 */
import "dotenv/config";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { kbHeadings } from "../src/lib/knowledge";
import {
  SEED_ARTICLES,
  SEED_CATEGORIES,
  SEED_TAGS,
  type SeedArticle,
} from "./knowledge-seed/content";

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTICLES_DIR = join(HERE, "knowledge-seed", "articles");
const ACTOR = "seed:knowledge";

function readBody(article: SeedArticle): string {
  const path = join(ARTICLES_DIR, article.file);
  return readFileSync(path, "utf8").trim();
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env first.");
    process.exit(1);
  }

  // Fail fast on registry/filesystem drift before touching the database.
  const files = new Set(readdirSync(ARTICLES_DIR));
  const slugs = new Set<string>();
  for (const article of SEED_ARTICLES) {
    if (!files.has(article.file)) {
      console.error(`Missing article file: knowledge-seed/articles/${article.file}`);
      process.exit(1);
    }
    if (slugs.has(article.slug)) {
      console.error(`Duplicate article slug in registry: ${article.slug}`);
      process.exit(1);
    }
    slugs.add(article.slug);
    const headings = kbHeadings(readBody(article));
    if (headings.length === 0) {
      console.error(`Article ${article.slug} has no ## headings — anchors need them.`);
      process.exit(1);
    }
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query("BEGIN");
    // Platform catalogue tables (no RLS), but connecting as the app role is
    // still a superuser-safety concern — grant bypass harmlessly.
    await client.query("SELECT set_config('app.rls_bypass', 'on', true)");

    // 1) Categories ------------------------------------------------------
    const categoryIdBySlug = new Map<string, string>();
    for (const cat of SEED_CATEGORIES) {
      await client.query(
        `INSERT INTO knowledge_categories
           (slug, title, description, icon, tone, sort_order, is_active, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, true, $7)
         ON CONFLICT (slug) DO UPDATE SET
           title = EXCLUDED.title,
           description = EXCLUDED.description,
           icon = EXCLUDED.icon,
           tone = EXCLUDED.tone,
           sort_order = EXCLUDED.sort_order,
           is_active = true,
           updated_at = now()`,
        [cat.slug, cat.title, cat.description, cat.icon, cat.tone, cat.sortOrder, ACTOR],
      );
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM knowledge_categories WHERE slug = $1",
        [cat.slug],
      );
      categoryIdBySlug.set(cat.slug, rows[0].id);
    }
    console.log(`categories: ${categoryIdBySlug.size}`);

    // 2) Tags -------------------------------------------------------------
    const tagIdBySlug = new Map<string, string>();
    for (const tag of SEED_TAGS) {
      await client.query(
        `INSERT INTO knowledge_tags (slug, label, description, created_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (slug) DO UPDATE SET
           label = EXCLUDED.label,
           description = EXCLUDED.description`,
        [tag.slug, tag.label, tag.description, ACTOR],
      );
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM knowledge_tags WHERE slug = $1",
        [tag.slug],
      );
      tagIdBySlug.set(tag.slug, rows[0].id);
    }
    console.log(`tags: ${tagIdBySlug.size}`);

    // 3) Articles --------------------------------------------------------
    let articlesDone = 0;
    for (const article of SEED_ARTICLES) {
      const body = readBody(article);
      const categoryId = categoryIdBySlug.get(article.category) ?? null;
      if (article.category && !categoryId) {
        throw new Error(`Unknown category slug '${article.category}' for article ${article.slug}`);
      }
      await client.query(
        `INSERT INTO knowledge_articles
           (slug, category_id, section_keys, title, summary, body_md, status,
            sort_order, published_at, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'published', $7, now(), $8, $8)
         ON CONFLICT (slug) DO UPDATE SET
           category_id = EXCLUDED.category_id,
           section_keys = EXCLUDED.section_keys,
           title = EXCLUDED.title,
           summary = EXCLUDED.summary,
           body_md = EXCLUDED.body_md,
           status = 'published',
           sort_order = EXCLUDED.sort_order,
           updated_by = EXCLUDED.updated_by,
           updated_at = now(),
           published_at = coalesce(knowledge_articles.published_at, now())`,
        [
          article.slug,
          categoryId,
          article.sectionKeys,
          article.title,
          article.summary,
          body,
          article.sortOrder,
          ACTOR,
        ],
      );
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM knowledge_articles WHERE slug = $1",
        [article.slug],
      );
      const articleId = rows[0].id;

      // 4) Tag links — replace set on every run so the registry is authoritative.
      await client.query("DELETE FROM knowledge_article_tags WHERE article_id = $1", [articleId]);
      for (const tagSlug of article.tagSlugs) {
        const tagId = tagIdBySlug.get(tagSlug);
        if (!tagId) throw new Error(`Unknown tag slug '${tagSlug}' for article ${article.slug}`);
        await client.query(
          "INSERT INTO knowledge_article_tags (article_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [articleId, tagId],
        );
      }
      articlesDone++;
    }
    console.log(`articles: ${articlesDone}`);

    await client.query("COMMIT");
    console.log("Knowledge base seeded. Open /dashboard/knowledge to read it.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("seed-knowledge failed:", err);
  process.exit(1);
});
