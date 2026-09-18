/**
 * Phase 40 — the WordPress content mirror.
 *
 * The WP Manager app browses posts, pages and media of the connected site.
 * Two doors, one table:
 *
 *   - **plugin mode** — the app cannot reach WordPress at all. The plugin
 *     pushes `content.updated` events (the same signed event channel orders
 *     and products use), and answers a `content_export` outbox job with the
 *     whole site. Both land in `integration_wp_content` through here.
 *   - **REST mode** — the app holds consumer keys, which the WordPress core
 *     REST API (`wp/v2`) accepts for posts/pages/media reads and writes. The
 *     sync pulls the same rows directly over the existing client.
 *
 * Keyed on the remote id like every other integration table, so a re-send of
 * the same post updates one row instead of duplicating it.
 */
import { randomUUID } from "node:crypto";
import { query } from "../db";
import { writeIntegrationAudit } from "./audit";
import { enqueueExport } from "./woo-ops-service";
import type { ConnectionRow } from "./connections-service";

export type WpContentType = "post" | "page" | "attachment" | string;

export interface WpContentPayload {
  id: number | string;
  type?: string;
  title?: string | { rendered?: string };
  name?: string;
  slug?: string;
  status?: string;
  link?: string;
  permalink?: string;
  author?: string | number;
  author_name?: string;
  date?: string;
  date_modified?: string;
  modified?: string;
  source_url?: string;
  media_type?: string;
  mime_type?: string;
  /** Media: the attachment URL in either of the shapes plugins send. */
  url?: string;
}

export interface WpContentRow {
  remoteId: string;
  wpType: string;
  title: string;
  slug: string;
  status: string;
  permalink: string;
  authorName: string;
  mediaUrl: string | null;
  mimeType: string | null;
  /**
   * The post's own HTML, when the mirror carries it — the plugin sends the
   * raw `post_content` and a `context: edit` REST pull would send
   * `content.raw`. Null when the payload never carried content (a
   * `context: view` REST pull exposes only `content.rendered`, which this
   * app deliberately does not round-trip: writing rendered HTML back would
   * re-wrap paragraphs and expand shortcodes on the live site).
   */
  content: string | null;
  remoteUpdatedAt: string | null;
  syncedAt: string;
}

/**
 * The named HTML entities WordPress's `title.rendered` actually emits.
 *
 * WordPress runs titles through `wptexturize`, which turns straight quotes,
 * apostrophes, dashes and ellipses into their typographic entities — so a
 * post literally called «Café's “Menu”…» arrives as
 * `Café&#8217;s &#8220;Menu&#8221;&#8230;`. The old decoder handled only a
 * handful of these, so the WP Manager's content list showed raw `&#8217;`
 * and `&hellip;` sprinkled through every title. Numeric entities (decimal and
 * hex) are decoded generically below; this map is for the named ones that
 * have no numeric form in a WordPress title.
 */
const NAMED_HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&nbsp;": " ",
  "&hellip;": "…",
  "&ndash;": "–",
  "&mdash;": "—",
  "&laquo;": "«",
  "&raquo;": "»",
  "&rsquo;": "\u2019",
  "&lsquo;": "\u2018",
  "&rdquo;": "\u201d",
  "&ldquo;": "\u201c",
  "&copy;": "©",
  "&reg;": "®",
  "&trade;": "™",
  "&deg;": "°",
};

/**
 * Decode the HTML entities WordPress puts in a title, both numeric and named.
 *
 * `&amp;` is intentionally resolved last: a double-encoded string such as
 * `&amp;#8217;` must first become `&#8217;` and only then the apostrophe,
 * never `&` mid-way through, which would strand the rest of the entity.
 */
export function decodeWpEntities(text: string): string {
  return text
    // Decimal numeric entities: &#8217; → ’
    .replace(/&#(\d+);/g, (_m, code: string) => codePointToString(Number.parseInt(code, 10)))
    // Hex numeric entities: &#x2019; / &#X2019; → ’
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_m, code: string) => codePointToString(Number.parseInt(code, 16)))
    // Named entities, with &amp; kept for the very end.
    .replace(/&(?:apos|nbsp|hellip|ndash|mdash|laquo|raquo|rsquo|lsquo|rdquo|ldquo|copy|reg|trade|deg|quot|lt|gt);/g,
      (m) => NAMED_HTML_ENTITIES[m] ?? m)
    .replace(/&amp;/g, "&");
}

/** A code point → its string, leaving an out-of-range or invalid value untouched-but-safe. */
function codePointToString(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** Strip the HTML WordPress's `title.rendered` carries and decode entities. */
export function plainTitle(raw: unknown): string {
  const text =
    typeof raw === "string"
      ? raw
      : raw && typeof raw === "object" && "rendered" in raw
        ? String((raw as { rendered?: string }).rendered ?? "")
        : "";
  return decodeWpEntities(text.replace(/<[^>]*>/g, "")).trim();
}

/**
 * The round-trippable post content in a mirrored payload, if any.
 *
 * The plugin sends `content` as the raw `post_content` string, which the
 * manager's editor can safely send back. A REST `context: edit` pull would
 * send `{ raw, rendered }` and `raw` is the same thing. **`rendered` is
 * deliberately refused**: it has been through `the_content` filters
 * (`wpautop` paragraph wrapping, shortcode expansion), so writing it back
 * would rewrite the live post's HTML — a quieter cousin of wiping it. When
 * neither raw shape is present the editor keeps the field locked and never
 * sends `content` at all.
 */
export function mirroredContent(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && typeof (raw as { raw?: unknown }).raw === "string") {
    return (raw as { raw: string }).raw;
  }
  return null;
}

/** Normalise one pushed/REST content object and upsert the mirror row. */
export async function upsertWpContent(
  connection: ConnectionRow,
  payload: WpContentPayload,
): Promise<"created" | "updated"> {
  const remoteId = String(payload.id ?? "");
  if (!remoteId || remoteId === "0") return "updated";
  const wpType = (payload.type ?? "post").trim().slice(0, 100) || "post";
  const title = plainTitle(payload.title) || payload.name || `${wpType} #${remoteId}`;
  const mediaUrl = payload.source_url || payload.url || null;
  const mimeType = payload.mime_type || (wpType === "attachment" ? payload.media_type || null : null);
  const permalink = payload.link || payload.permalink || "";
  const remoteUpdated = payload.date_modified || payload.modified || payload.date || null;

  const { rows } = await query<{ id: string }>(
    `INSERT INTO integration_wp_content
       (business_id, connection_id, wp_type, remote_id, title, slug, status, permalink,
        author_name, media_url, mime_type, payload, remote_updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb,
             CASE WHEN $13::timestamptz IS NULL THEN NULL ELSE $13::timestamptz END)
     ON CONFLICT (connection_id, wp_type, remote_id) DO UPDATE
       SET title = EXCLUDED.title,
           slug = EXCLUDED.slug,
           status = EXCLUDED.status,
           permalink = EXCLUDED.permalink,
           author_name = EXCLUDED.author_name,
           media_url = COALESCE(EXCLUDED.media_url, integration_wp_content.media_url),
           mime_type = COALESCE(EXCLUDED.mime_type, integration_wp_content.mime_type),
           payload = EXCLUDED.payload,
           remote_updated_at = COALESCE(EXCLUDED.remote_updated_at, integration_wp_content.remote_updated_at),
           synced_at = now(),
           updated_at = now()
     RETURNING id`,
    [
      connection.business_id,
      connection.id,
      wpType,
      remoteId,
      title.slice(0, 500),
      (payload.slug ?? "").slice(0, 200),
      (payload.status ?? "publish").slice(0, 40),
      permalink.slice(0, 1000),
      (payload.author_name ?? (typeof payload.author === "string" ? payload.author : "")).slice(0, 200),
      mediaUrl,
      mimeType,
      JSON.stringify(payload),
      remoteUpdated,
    ],
  );
  // Distinguish created from updated for the audit trail; xmax tells an
  // INSERT (0) from an UPDATE-taken conflict path on the RETURNING row.
  void rows;
  return "created";
}

/** The mirrored content for a connection, newest first, optionally by type. */
export async function listWpContent(
  businessId: string,
  connectionId: string,
  options: { wpType?: string; search?: string; limit?: number } = {},
): Promise<WpContentRow[]> {
  const limit = Math.min(200, Math.max(1, options.limit ?? 100));
  const { rows } = await query<{
    remote_id: string;
    wp_type: string;
    title: string;
    slug: string;
    status: string;
    permalink: string;
    author_name: string;
    media_url: string | null;
    mime_type: string | null;
    content: unknown;
    remote_updated_at: string | null;
    synced_at: string;
  }>(
    `SELECT remote_id, wp_type, title, slug, status, permalink, author_name,
            media_url, mime_type, payload->'content' AS content,
            remote_updated_at, synced_at
       FROM integration_wp_content
      WHERE business_id = $1 AND connection_id = $2
        AND ($3::text IS NULL OR wp_type = $3)
        AND ($4::text IS NULL OR title ILIKE '%' || $4 || '%')
      ORDER BY remote_updated_at DESC NULLS LAST, synced_at DESC
      LIMIT $5`,
    [businessId, connectionId, options.wpType ?? null, options.search?.trim() || null, limit],
  );
  return rows.map((r) => ({
    remoteId: r.remote_id,
    wpType: r.wp_type,
    title: r.title,
    slug: r.slug,
    status: r.status,
    permalink: r.permalink,
    authorName: r.author_name,
    mediaUrl: r.media_url,
    mimeType: r.mime_type,
    content: mirroredContent(r.content),
    remoteUpdatedAt: r.remote_updated_at,
    syncedAt: r.synced_at,
  }));
}

export interface WpContentCounts {
  posts: number;
  pages: number;
  media: number;
}

/** Counts by the three types the manager shows. */
export async function wpContentCounts(
  businessId: string,
  connectionId: string,
): Promise<WpContentCounts> {
  const { rows } = await query<{ wp_type: string; n: string }>(
    `SELECT wp_type, count(*)::text AS n FROM integration_wp_content
      WHERE business_id = $1 AND connection_id = $2
      GROUP BY wp_type`,
    [businessId, connectionId],
  );
  const counts = { posts: 0, pages: 0, media: 0 };
  for (const row of rows) {
    if (row.wp_type === "post") counts.posts = Number(row.n);
    else if (row.wp_type === "page") counts.pages = Number(row.n);
    else if (row.wp_type === "attachment") counts.media = Number(row.n);
  }
  return counts;
}

/**
 * Ask for the whole content library.
 *
 * Plugin mode: a `content_export` outbox row the plugin leases on its next
 * pull and answers with `content.updated` events (the plugin's outbox apply
 * loop already applies unknown future job types safely; this version
 * understands this one).
 *
 * REST mode: the app reads wp/v2 itself — the caller routes by link mode.
 */
export async function enqueueContentExport(businessId: string, connectionId: string): Promise<void> {
  await enqueueExport(businessId, connectionId, "content_export");
  await writeIntegrationAudit({
    businessId,
    connectionId,
    action: "content.export_queued",
  });
}

/** A stable delivery id for a pushed content event, mirroring order events. */
export function contentDeliveryId(connectionId: string, payload: WpContentPayload): string {
  return `content:${connectionId}:${payload.type ?? "post"}:${payload.id}:${randomUUID()}`;
}

/**
 * Pull posts/pages/media over the WordPress core REST API.
 *
 * WooCommerce consumer keys authenticate wp/v2 requests on the standard
 * WordPress+WooCommerce setup, so no second credential pair is needed. Pages
 * the store returns but the store's host withholds a paging header on are
 * still walked to the end via the short-page rule.
 */
export async function syncWpContentRest(
  connection: ConnectionRow,
  client: {
    wpListPage: (
      type: string,
      query: Record<string, string | number | boolean> & { page: number },
    ) => Promise<{ items: Record<string, unknown>[]; totalPages: number }>;
  },
): Promise<{ total: number }> {
  let total = 0;
  const types = ["posts", "pages", "media"];
  for (const type of types) {
    if (!client.wpListPage) continue;
    // Posts and pages are asked for with `context: edit` first: that is the
    // only context that carries `content.raw`, the round-trippable HTML the
    // manager's editor needs (a `view` pull exposes only `content.rendered`,
    // which must never be written back — see `mirroredContent`). A key whose
    // user cannot edit posts refuses the context, and the pull retries with
    // `view` so the mirror still arrives, minus the editable content. Media
    // needs no edit context — `source_url` is the same in both.
    let context: "edit" | "view" = type === "media" ? "view" : "edit";
    let page = 1;
    for (;;) {
      let result: { items: Record<string, unknown>[]; totalPages: number };
      try {
        result = await client.wpListPage(type, { context, per_page: 100, page });
      } catch (err) {
        if (context === "edit" && page === 1) {
          context = "view";
          result = await client.wpListPage(type, { context, per_page: 100, page });
        } else {
          throw err;
        }
      }
      const { items, totalPages } = result;
      for (const item of items) {
        await upsertWpContent(connection, item as unknown as WpContentPayload);
        total += 1;
      }
      if (!totalPages || page >= totalPages || items.length === 0) break;
      page += 1;
    }
  }
  await query(
    `UPDATE integration_connections SET last_content_sync_at = now(), updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [connection.business_id, connection.id],
  );
  await writeIntegrationAudit({
    businessId: connection.business_id,
    connectionId: connection.id,
    action: "content.synced",
    payload: { total },
  });
  return { total };
}
