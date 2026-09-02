/**
 * The in-product knowledge base — the pure half.
 *
 * Migration 0131 stores the knowledge base the super-admin maintains (the
 * console at /platform/knowledge writes it; member routes under /api/knowledge
 * read it; «مرکز آموزش» at /dashboard/knowledge displays it). Everything here
 * is pure: no database, no request context, so both realms — and the unit
 * tests — share exactly these rules.
 *
 * What lives here:
 *
 *  - Slugs. Article/category/tag slugs are ASCII (`pos-basics`), because they
 *    become URL path segments; a Persian title alone suggests no slug, so the
 *    console either auto-suggests from latin characters or asks the operator.
 *  - Heading anchors. Every article heading gets a stable id derived from its
 *    text (Persian-aware, GitHub-style), so a guide can deep-link «#بستن-صندوق»
 *    and the «در این صفحه» table of contents is computed with the same code
 *    that renders the headings — the two can never disagree.
 *  - Media. An article's video is either a direct file (`.mp4`/…) rendered as
 *    a player, or a page on a video host (Aparat/YouTube/…) rendered as an
 *    embed; the kind is decided here so the console preview and the member
 *    view agree.
 *  - Plain-text extraction for search snippets and summaries.
 *
 * Types shared by the API payloads live here too, so the console editor, the
 * member centre and the routes all speak one shape.
 */

// ---------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------

/** Slugs are URL path segments: lowercase Latin, digits, single dashes. */
export const KB_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isKbSlug(value: string): boolean {
  return KB_SLUG_PATTERN.test(value);
}

/**
 * Suggest a slug from a title. Keeps only `[a-z0-9 -]`, so a fully Persian
 * title yields "" and the caller must ask for (or invent) a slug — slugs are
 * URLs, and a URL made of stripped-to-nothing text is worse than no guess.
 */
export function suggestKbSlug(title: string): string {
  const base = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return isKbSlug(base) ? base : "";
}

// ---------------------------------------------------------------------------
// Heading anchors ("anchor text to titles")
// ---------------------------------------------------------------------------

export interface KbHeading {
  /** Markdown depth: 2 for `##`, 3 for `###`, 4 for `####`. */
  depth: number;
  /** The heading text, stripped of inline markdown marks. */
  text: string;
  /** The anchor id the renderer assigns to the heading element. */
  id: string;
  /**
   * 1-based source line of the heading — how the markdown renderer matches an
   * AST heading node (`node.position.start.line`) to the anchor computed
   * here, so a heading quoted inside a blockquote simply gets no anchor
   * instead of shifting every later id.
   */
  line: number;
}

/**
 * Persian-aware anchor slug: lowercase, strip diacritics and punctuation,
 * ZWNJ (نیم‌فاصله) and whitespace become dashes, Persian/Arabic letters and
 * digits are kept as-is (URL fragments percent-encode them harmlessly).
 */
export function kbHeadingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[ً-ْ]/g, "") // Arabic diacritics (تشکیل)
    .replace(/‌/g, "-") // ZWNJ
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/[\s]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The headings of a markdown document, in order, each with the unique anchor
 * id the renderer will give it (duplicates get `-2`, `-3`, …). Headings
 * inside fenced code blocks are not headings; ATX (`#`) headings only, since
 * that is the only spelling the editor toolbar and the seed content use, and
 * only `##`–`####` count — `#` is the article title itself in this system.
 */
export function kbHeadings(markdown: string): KbHeading[] {
  const headings: KbHeading[] = [];
  const seen = new Map<string, number>();
  let fence: string | null = null;
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1].slice(0, 3);
      fence = fence === marker ? null : fence ?? marker;
      continue;
    }
    if (fence) continue;
    const m = line.match(/^(#{2,4})\s+(.+?)\s*#*\s*$/);
    if (!m) continue;
    const depth = m[1].length;
    const text = stripInlineMarkdown(m[2]);
    const base = kbHeadingSlug(text) || "section";
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    headings.push({ depth, text, id: count === 1 ? base : `${base}-${count}`, line: i + 1 });
  }
  return headings;
}

// ---------------------------------------------------------------------------
// Rich media
// ---------------------------------------------------------------------------

/** A video the UI can render: a file (player) or a page (iframe embed). */
export type KbVideoKind = "file" | "embed";

const VIDEO_FILE_EXT = /\.(mp4|webm|mov|m4v|ogv|ogg)$/i;

/**
 * Classify a media URL. Returns null for anything that is not a clean http(s)
 * URL — the editor stores "" and treats that as "no video". A direct video
 * file gets the native player; anything else (an Aparat `v/…` page, a YouTube
 * watch/embed URL, …) loads in a sandboxed iframe, exactly the shape the
 * existing «آموزش» modal already trusts for external pages.
 */
export function kbVideoKind(url: string): KbVideoKind | null {
  const parsed = parseHttpUrl(url);
  if (!parsed) return null;
  return VIDEO_FILE_EXT.test(parsed.pathname) ? "file" : "embed";
}

/** An http(s) URL, trimmed — null for anything else (or ""). */
export function parseHttpUrl(raw: string): URL | null {
  const value = raw.trim();
  if (!/^https?:\/\/\S+$/i.test(value)) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Markdown → plain text (search snippets, summary fallback)
// ---------------------------------------------------------------------------

/** Strip inline emphasis/link/code marks so a heading or snippet reads clean. */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // image → alt text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // link → label
    .replace(/`([^`]*)`/g, "$1") // inline code
    .replace(/\*\*([^*]+)\*\*/g, "$1") // bold
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|\W)\*([^*\n]+)\*(?!\*)/g, "$1$2") // italic
    .replace(/(^|\W)_([^_\n]+)_(?!_)/g, "$1$2")
    .replace(/~~([^~]+)~~/g, "$1")
    .trim();
}

/**
 * Collapse a markdown document to searchable plain text: fence markers and
 * list/quote/table punctuation drop out, code and prose stay. Good enough for
 * a snippet around a hit; not a rendering engine (that is react-markdown).
 */
export function stripMarkdown(markdown: string): string {
  let fence: string | null = null;
  const out: string[] = [];
  for (const line of markdown.split("\n")) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1].slice(0, 3);
      fence = fence === marker ? null : fence ?? marker;
      continue;
    }
    if (fence) {
      out.push(line);
      continue;
    }
    // Headings and table separator rows lose their markup; images keep alt.
    const cleaned = line
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/^\s*>\s?/, "")
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/^\|?(?:\s*:?-+:?\s*\|)+\s*$/, "");
    const text = stripInlineMarkdown(cleaned).trim();
    if (text) out.push(text);
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * A short window of plain text around the first occurrence of `query`,
 * marked with … when clipped. Falls back to the leading window when the
 * query is absent or not found (e.g. the hit was in the title only).
 */
export function kbSnippet(text: string, query: string, radius = 90): string {
  const haystack = text.toLowerCase();
  const needle = query.trim().toLowerCase();
  const at = needle ? haystack.indexOf(needle) : -1;
  if (at === -1) {
    const head = text.slice(0, radius * 2).trimEnd();
    return head.length < text.length ? `${head}…` : head;
  }
  const from = Math.max(0, at - radius);
  const to = Math.min(text.length, at + needle.length + radius);
  const snippet = text.slice(from, to).trim();
  return `${from > 0 ? "…" : ""}${snippet}${to < text.length ? "…" : ""}`;
}

/** Split `text` into segments, each flagged hit/miss against every query term. */
export interface KbHighlightSegment {
  text: string;
  hit: boolean;
}

/**
 * Highlight every occurrence of the query's terms (Persian words included),
 * case-insensitively, so the search list can wrap hits in <mark>. Terms are
 * regex-escaped — a query of "(" highlights literally instead of throwing.
 */
export function kbHighlightSegments(text: string, query: string): KbHighlightSegment[] {
  const terms = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!terms.length || !text) return [{ text, hit: false }];
  const pattern = new RegExp(`(${terms.join("|")})`, "gi");
  const segments: KbHighlightSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) segments.push({ text: text.slice(last, index), hit: false });
    segments.push({ text: match[0], hit: true });
    last = index + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), hit: false });
  return segments.length ? segments : [{ text, hit: false }];
}

// ---------------------------------------------------------------------------
// The category tree (the member side menu, the console's category builder)
// ---------------------------------------------------------------------------

export interface KbCategoryFlat {
  id: string;
  parentId: string | null;
  slug: string;
  title: string;
  description: string;
  icon: string;
  tone: string;
  sortOrder: number;
}

export interface KbCategoryNode extends KbCategoryFlat {
  children: KbCategoryNode[];
}

/**
 * Nest the flat category list into a tree. Sorts every level by sort_order
 * then title, and guards against a cycle (a category whose parent chain loops
 * back — only possible from hand-edited data) by simply not visiting a node
 * twice; orphans attach to the root so tree damage never hides a category.
 */
export function buildKbCategoryTree(flat: readonly KbCategoryFlat[]): KbCategoryNode[] {
  const byId = new Map(flat.map((c) => [c.id, { ...c, children: [] as KbCategoryNode[] }]));
  const roots: KbCategoryNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent && parent.id !== node.id) parent.children.push(node);
    else roots.push(node);
  }
  const sortLevel = (nodes: KbCategoryNode[]) => {
    nodes.sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title, "fa"));
    nodes.forEach((n) => sortLevel(n.children));
  };
  sortLevel(roots);
  return roots;
}

// ---------------------------------------------------------------------------
// API payload shapes (member side)
// ---------------------------------------------------------------------------

export interface KbTagRef {
  slug: string;
  label: string;
}

export interface KbArticleListItem {
  id: string;
  slug: string;
  title: string;
  summary: string;
  categoryId: string | null;
  sectionKeys: string[];
  tags: KbTagRef[];
  hasVideo: boolean;
  hasCover: boolean;
  sortOrder: number;
  updatedAt: string;
}

export interface KbArticleDetail extends KbArticleListItem {
  bodyMd: string;
  videoUrl: string;
  videoKind: KbVideoKind | null;
  coverImageUrl: string;
  publishedAt: string | null;
  related: KbArticleListItem[];
}

export interface KbCataloguePayload {
  categories: KbCategoryFlat[];
  articles: KbArticleListItem[];
  tags: KbTagRef[];
}

export interface KbSearchHit {
  slug: string;
  title: string;
  summary: string;
  snippet: string;
  categoryTitle: string | null;
  tags: KbTagRef[];
  updatedAt: string;
}

/** Section keys a stored string array may claim, validated against the catalogue. */
export function normalizeSectionKeys(value: unknown, knownKeys: ReadonlySet<string>): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const key of value) {
    if (typeof key !== "string") continue;
    const trimmed = key.trim();
    if (trimmed && knownKeys.has(trimmed)) seen.add(trimmed);
  }
  return [...seen];
}
