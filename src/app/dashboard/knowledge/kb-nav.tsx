"use client";

/**
 * The knowledge centre's side menu + search — the «فهرست کناری» of the design
 * system. Both knowledge pages (the home browser and the article view) render
 * this on their right (RTL leading) edge:
 *
 *  - a search box wired to /api/knowledge/search (debounced), whose hits the
 *    parent shows instead of the category view;
 *  - the category tree built with the same buildKbCategoryTree the console
 *    preview uses, expandable, with the articles of the open category listed;
 *  - the tag chips, which switch the main pane to a tag-filtered list.
 *
 * On phones the whole menu hides behind a «فهرست راهنماها» toggle so the
 * article gets the full width.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ChevronDownIcon,
  FileTextIcon,
  ListTreeIcon,
  PlayCircleIcon,
  SearchIcon,
  TagIcon,
  XIcon,
} from "lucide-react";
import {
  buildKbCategoryTree,
  kbHighlightSegments,
  type KbCataloguePayload,
  type KbCategoryNode,
  type KbSearchHit,
} from "@/lib/knowledge";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { api, inputClass } from "../ui";
import { cardClass } from "../page-chrome";

export function articleHref(slug: string): string {
  return `/knowledge/a/${encodeURIComponent(slug)}`;
}

/** Sidebar search state, owned here so home/article pages share the behaviour. */
export function useKbSearch() {
  const [queryText, setQueryText] = useState("");
  const [results, setResults] = useState<KbSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback((q: string) => {
    if (timer.current) clearTimeout(timer.current);
    if (!q.trim()) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    timer.current = setTimeout(async () => {
      const { ok, data } = await api<{ results: KbSearchHit[] }>(
        `/api/knowledge/search?q=${encodeURIComponent(q.trim())}`,
      );
      if (ok) setResults(data.results);
      setSearching(false);
    }, 300);
  }, []);

  const onQueryChange = useCallback(
    (q: string) => {
      setQueryText(q);
      run(q);
    },
    [run],
  );

  const clear = useCallback(() => onQueryChange(""), [onQueryChange]);

  return { query: queryText, results, searching, onQueryChange, clear };
}

/** Placeholder rows while the catalogue loads (a *Skeleton by the loading rule). */
export function SideMenuSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div role="status" aria-busy="true" aria-label="در حال آماده‌سازی فهرست" className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} aria-hidden="true" className="h-9 rounded-lg" />
      ))}
    </div>
  );
}

export function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {kbHighlightSegments(text, query).map((seg, i) =>
        seg.hit ? (
          <mark
            key={i}
            className="rounded-sm bg-amber-200/70 px-0.5 text-inherit dark:bg-amber-500/30"
          >
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

/** One category row of the tree, with expandable children and article links. */
function CategoryNode({
  node,
  articlesByCategory,
  activeSlug,
  depth,
  expanded,
  setNodeOpen,
  onNavigate,
}: {
  node: KbCategoryNode;
  articlesByCategory: Map<string, KbCataloguePayload["articles"]>;
  activeSlug?: string;
  depth: number;
  expanded: Record<string, boolean>;
  setNodeOpen: (id: string, open: boolean) => void;
  onNavigate?: () => void;
}) {
  const articles = articlesByCategory.get(node.id) ?? [];
  const hasKids = node.children.length > 0 || articles.length > 0;
  // Root categories start open; any explicit toggle wins over the default.
  const isOpen = expanded[node.id] ?? depth === 0;
  return (
    <li>
      <div className="flex items-center" style={{ paddingInlineStart: `${depth * 12}px` }}>
        <button
          type="button"
          onClick={() => setNodeOpen(node.id, !isOpen)}
          aria-expanded={isOpen}
          className="flex min-h-9 w-full items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-foreground/85 transition-colors hover:bg-muted"
        >
          <span className="shrink-0" aria-hidden="true">
            {node.icon || "📁"}
          </span>
          <span className="min-w-0 flex-1 truncate text-start">{node.title}</span>
          {hasKids ? (
            <ChevronDownIcon
              aria-hidden="true"
              className={`size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${isOpen ? "" : "ltr:-rotate-90 rtl:rotate-90"}`}
            />
          ) : null}
        </button>
      </div>
      {isOpen ? (
        <ul className="mt-0.5 space-y-0.5">
          {articles.map((a) => {
            const active = activeSlug === a.slug;
            return (
              <li key={a.id}>
                <Link
                  href={articleHref(a.slug)}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  style={{ paddingInlineStart: `${depth * 12 + 26}px` }}
                  className={`flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-[13px] transition-colors ${
                    active
                      ? "bg-amber-100 font-semibold text-amber-950 dark:bg-amber-500/20 dark:text-amber-200"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  {a.hasVideo ? (
                    <PlayCircleIcon className="size-3.5 shrink-0" aria-hidden="true" />
                  ) : (
                    <FileTextIcon className="size-3.5 shrink-0" aria-hidden="true" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{a.title}</span>
                </Link>
              </li>
            );
          })}
          {node.children.map((child) => (
            <CategoryNode
              key={child.id}
              node={child}
              articlesByCategory={articlesByCategory}
              activeSlug={activeSlug}
              depth={depth + 1}
              expanded={expanded}
              setNodeOpen={setNodeOpen}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** The full side menu (tree + tags). Renders a skeleton while the catalogue loads. */
export function KbSideMenu({
  catalogue,
  query,
  onQueryChange,
  searching,
  activeSlug,
  onNavigate,
}: {
  catalogue: KbCataloguePayload | null;
  query: string;
  onQueryChange: (q: string) => void;
  searching: boolean;
  activeSlug?: string;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const setNodeOpen = useCallback(
    (id: string, open: boolean) => setExpanded((prev) => ({ ...prev, [id]: open })),
    [],
  );

  // Open the branch of the article being read, without the user touching anything.
  useEffect(() => {
    if (!catalogue) return;
    const byCategory = new Map(catalogue.articles.map((a) => [a.slug, a.categoryId] as const));
    const categoryId = activeSlug ? byCategory.get(activeSlug) : undefined;
    if (!categoryId) return;
    setExpanded((prev) => ({ ...prev, [categoryId]: true }));
  }, [catalogue, activeSlug, pathname]);

  const tree = useMemo(
    () => (catalogue ? buildKbCategoryTree(catalogue.categories) : []),
    [catalogue],
  );
  const articlesByCategory = useMemo(() => {
    const map = new Map<string, KbCataloguePayload["articles"]>();
    for (const a of catalogue?.articles ?? []) {
      const key = a.categoryId ?? "";
      map.set(key, [...(map.get(key) ?? []), a]);
    }
    return map;
  }, [catalogue]);
  const uncategorized = articlesByCategory.get("") ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="relative">
        <SearchIcon
          aria-hidden="true"
          className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="جست‌وجو در راهنماها…"
          aria-label="جست‌وجو در پایگاه دانش"
          aria-busy={searching}
          className={`${inputClass} ps-9 pe-9`}
        />
        {query ? (
          <button
            type="button"
            onClick={() => onQueryChange("")}
            aria-label="پاک کردن جست‌وجو"
            title="پاک کردن جست‌وجو"
            className="absolute end-2 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <XIcon className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <nav aria-label="فهرست بخش‌های راهنما" className="min-h-0 flex-1 overflow-y-auto pe-1">
        {catalogue === null ? (
          <SideMenuSkeleton rows={4} />
        ) : (
          <ul className="space-y-0.5">
            {tree.map((node) => (
              <CategoryNode
                key={node.id}
                node={node}
                articlesByCategory={articlesByCategory}
                activeSlug={activeSlug}
                depth={0}
                expanded={expanded}
                setNodeOpen={setNodeOpen}
                onNavigate={onNavigate}
              />
            ))}
            {uncategorized.map((a) => (
              <li key={a.id}>
                <Link
                  href={articleHref(a.slug)}
                  onClick={onNavigate}
                  className="flex min-h-9 items-center gap-1.5 rounded-lg px-2 ps-[34px] text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <FileTextIcon className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{a.title}</span>
                </Link>
              </li>
            ))}
            {tree.length === 0 && uncategorized.length === 0 ? (
              <li className="px-2 py-6 text-center text-xs leading-5 text-muted-foreground">
                هنوز راهنمایی منتشر نشده است.
              </li>
            ) : null}
          </ul>
        )}
      </nav>

      {catalogue && catalogue.tags.length > 0 ? (
        <div className="border-t border-border/70 pt-3">
          <p className="mb-2 flex items-center gap-1.5 px-1 text-xs font-semibold text-muted-foreground">
            <TagIcon className="size-3.5" aria-hidden="true" />
            برچسب‌ها
          </p>
          <div className="flex flex-wrap gap-1.5">
            {catalogue.tags.map((t) => (
              <Link
                key={t.slug}
                href={`/knowledge?tag=${encodeURIComponent(t.slug)}`}
                onClick={onNavigate}
                className="rounded-full border border-border/80 bg-card px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                #{t.label}
              </Link>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The search-results pane shared by the home browser and the article view:
 * whenever the side menu's box holds a query, the main column switches to
 * this list of ranked hits (title + snippet, hits highlighted).
 */
export function KbSearchResults({
  query,
  results,
  searching,
}: {
  query: string;
  results: KbSearchHit[] | null;
  searching: boolean;
}) {
  if (results === null || searching) {
    return (
      <div role="status" aria-busy="true" aria-label="در حال جست‌وجو در راهنماها" className="space-y-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} aria-hidden="true" className={`h-20 ${cardClass}`} />
        ))}
      </div>
    );
  }
  return (
    <section aria-label={`نتایج جست‌وجو برای «${query.trim()}»`} className={`${cardClass} p-4 sm:p-5`}>
      <h2 className="mb-1 text-sm font-semibold text-foreground">
        نتایج جست‌وجو برای «{query.trim()}»
      </h2>
      <p className="mb-3 text-xs text-muted-foreground">
        {formatPersianNumber(results.length)} راهنما پیدا شد
      </p>
      {results.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          چیزی پیدا نشد؛ عبارت دیگری را امتحان کنید یا از فهرست کناری استفاده کنید.
        </p>
      ) : (
        <ul className="space-y-2">
          {results.map((hit) => (
            <li key={hit.slug}>
              <Link
                href={articleHref(hit.slug)}
                className="block rounded-xl border border-border/70 bg-card px-4 py-3 transition-colors hover:bg-muted/40"
              >
                <p className="text-sm font-semibold text-foreground">
                  <Highlighted text={hit.title} query={query} />
                  {hit.categoryTitle ? (
                    <span className="ms-2 text-xs font-normal text-muted-foreground">
                      در {hit.categoryTitle}
                    </span>
                  ) : null}
                </p>
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                  <Highlighted text={hit.snippet} query={query} />
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The responsive side-menu frame: a fixed column on lg+, a slide-over panel on
 * small screens behind a toggle button the parents render.
 */
export function KbSideMenuFrame({
  catalogue,
  query,
  onQueryChange,
  searching,
  activeSlug,
}: {
  catalogue: KbCataloguePayload | null;
  query: string;
  onQueryChange: (q: string) => void;
  searching: boolean;
  activeSlug?: string;
}) {
  const [open, setOpen] = useState(false);
  const menu = (
    <KbSideMenu
      catalogue={catalogue}
      query={query}
      onQueryChange={onQueryChange}
      searching={searching}
      activeSlug={activeSlug}
      onNavigate={() => setOpen(false)}
    />
  );
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border/80 bg-card px-3 text-sm font-semibold text-foreground/80 shadow-[0_1px_2px_rgb(41_37_36/0.035)] transition-colors hover:bg-muted lg:hidden"
      >
        <ListTreeIcon className="size-4" aria-hidden="true" />
        فهرست راهنماها
        {catalogue ? (
          <span className="text-xs font-normal text-muted-foreground">
            ({toPersianDigits(catalogue.articles.length)} راهنما)
          </span>
        ) : null}
      </button>

      <aside className="hidden w-72 shrink-0 lg:block" aria-label="فهرست پایگاه دانش">
        <div className={`sticky top-4 max-h-[calc(100vh-6rem)] overflow-hidden p-3 ${cardClass}`}>
          {menu}
        </div>
      </aside>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="فهرست راهنماها"
          className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] lg:hidden"
          onClick={() => setOpen(false)}
        >
          <div
            className="absolute inset-y-0 start-0 flex w-[86vw] max-w-80 flex-col bg-card p-3 shadow-none"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="بستن فهرست"
              title="بستن فهرست"
              className="mb-2 inline-flex size-9 items-center justify-center self-end rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <XIcon className="size-5" aria-hidden="true" />
            </button>
            {menu}
          </div>
        </div>
      ) : null}
    </>
  );
}
