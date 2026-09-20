"use client";

/**
 * «دسته‌بندی و ویژگی‌ها» — the store's taxonomy tree, as the WP Manager's own
 * screen rather than a 15-line panel borrowed from the connection tester.
 *
 * What it is: a read mirror. Categories, tags, global attribute terms and any
 * custom taxonomy a plugin registered, keyed by *remote* id, refreshed by the
 * catalogue sync (see woo-taxonomy-service.ts for why this is a mirror and
 * not a local category model). Nothing here writes to the store, so the
 * screen's whole job is letting an owner find a term and understand two
 * numbers about it: how many products the store says carry it, and how many
 * of those this app has actually mapped.
 *
 * It replaces a panel that had a series of real problems:
 *
 *  - **`max-h-80` on the whole list.** The tree — the one thing the section
 *    exists to show — lived in a 320px box nested in the page's own scroller.
 *    On a phone that is roughly four rows, and the inner scroller ate the
 *    swipe that was meant to scroll the page.
 *  - **An accordion that closed the group you were reading.** `open` was a
 *    single string, so opening «برچسب‌ها» collapsed «دسته‌بندی‌ها»; comparing
 *    two taxonomies meant reopening one every time.
 *  - **Everything collapsed on arrival** with no way to search, so finding one
 *    category in a store with 300 of them meant opening groups and reading.
 *  - **`text-right` on the disclosure button**, which is a physical direction:
 *    correct only by accident in RTL and wrong the moment the shell is LTR.
 *    The rest of the app uses `text-start`.
 *  - **No hierarchy past one level.** A single «└» was drawn for any term with
 *    a parent, so a grandchild looked exactly like a child, and the sort put
 *    every root before every child anyway (fixed in `sortWooTerms`), which
 *    made those markers point at unrelated rows.
 *  - **No error state.** A failed request rendered «هنوز درخت دریافت نشده» —
 *    telling the owner to press a sync button that was not the problem.
 *  - **`toLocaleString("fa-IR")`** instead of the app's `toPersianDigits`,
 *    which is the one digit rule the rest of the dashboard follows.
 *  - **No refresh and no sync affordance**, in a section whose empty state is
 *    a sentence telling you to press a button that lives on another screen.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  FolderTreeIcon,
  RefreshCwIcon,
  SearchIcon,
  TagsIcon,
} from "lucide-react";
import { api } from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionCard, SectionCardSkeleton, StatusBadge, cardClass } from "@/app/dashboard/page-chrome";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useFeatureLocked } from "@/components/feature-lock";

export interface TermRow {
  remoteId: string;
  parentRemoteId: string | null;
  name: string;
  slug: string;
  /** Tree level, computed server-side — 0 for a root. */
  depth: number;
  /** «پوشاک › تی‌شرت › یقه‌دار», for the search hit that is three levels deep. */
  path: string;
  remoteCount: number;
  mappedCount: number;
}

export interface TermGroup {
  taxonomy: string;
  label: string;
  isAttribute: boolean;
  termCount: number;
  remoteCount: number;
  mappedCount: number;
  terms: TermRow[];
}

/** Indentation per tree level, capped so a deep store cannot squeeze the name off the row. */
const INDENT_REM = 1.15;
const MAX_INDENT_LEVEL = 4;

function indentStyle(depth: number) {
  return { marginInlineStart: `${Math.min(depth, MAX_INDENT_LEVEL) * INDENT_REM}rem` };
}

function normalise(value: string): string {
  // Arabic ye/kaf and the zero-width non-joiner are what a Persian search box
  // actually receives; without folding them «برچسب‌ها» never matches a typed
  // «برچسبها» and the owner concludes the search is broken.
  return value
    .toLowerCase()
    .replace(/\u200c/g, "")
    .replace(/[\u064a\u0649]/g, "ی")
    .replace(/\u0643/g, "ک")
    .trim();
}

export function TaxonomiesSection({ connectionId }: { connectionId: string }) {
  const locked = useFeatureLocked();
  const [groups, setGroups] = useState<TermGroup[] | null>(null);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [refreshing, setRefreshing] = useState(false);
  // A connection switched mid-flight must not have the previous store's tree
  // land on top of it; every load carries the id it was started for.
  const requestFor = useRef("");

  const load = useCallback(
    async (mode: "initial" | "refresh" = "initial") => {
      if (!connectionId || locked) return;
      requestFor.current = connectionId;
      if (mode === "refresh") setRefreshing(true);
      else setGroups(null);
      setError("");
      const { ok, data, status } = await api<{
        groups?: TermGroup[];
        syncedAt?: string | null;
        error?: string;
      }>(`/api/integrations/connections/${connectionId}/taxonomies`);
      if (requestFor.current !== connectionId) return;
      setRefreshing(false);
      if (!ok) {
        // The old panel showed the "not synced yet" copy for this, which sent
        // owners to press a sync button over a problem sync cannot fix.
        setGroups([]);
        setError(
          status === 403
            ? "دسترسی به دسته‌بندی‌های این فروشگاه مجاز نیست."
            : status === 404
              ? "این فروشگاه دیگر در دسترس نیست؛ فهرست فروشگاه‌ها را تازه کنید."
              : "خواندن دسته‌بندی‌ها ناموفق بود. دوباره تلاش کنید.",
        );
        return;
      }
      setGroups(data.groups ?? []);
      setSyncedAt(data.syncedAt ?? null);
    },
    [connectionId, locked],
  );

  useEffect(() => {
    void load("initial");
  }, [load]);

  // A new store starts with its own disclosure state and its own search.
  useEffect(() => {
    setClosed({});
    setQuery("");
  }, [connectionId]);

  const needle = normalise(query);
  const visible = useMemo(() => {
    if (!groups) return [];
    if (!needle) return groups;
    return groups
      .map((group) => {
        // A group whose *name* matches keeps all of its terms: searching
        // «ویژگی» should show the attribute groups whole, not empty shells.
        if (normalise(group.label).includes(needle) || normalise(group.taxonomy).includes(needle)) return group;
        const terms = group.terms.filter(
          (term) =>
            normalise(term.name).includes(needle) ||
            normalise(term.slug).includes(needle) ||
            normalise(term.path).includes(needle),
        );
        return terms.length ? { ...group, terms } : null;
      })
      .filter((group): group is TermGroup => group !== null);
  }, [groups, needle]);

  const totals = useMemo(() => {
    const all = groups ?? [];
    return {
      groups: all.length,
      terms: all.reduce((sum, g) => sum + g.termCount, 0),
      attributes: all.filter((g) => g.isAttribute).length,
      mapped: all.reduce((sum, g) => sum + g.mappedCount, 0),
    };
  }, [groups]);

  if (groups === null) return <SectionCardSkeleton rows={6} label="در حال خواندن دسته‌بندی‌ها" />;

  const hits = visible.reduce((sum, g) => sum + g.terms.length, 0);

  return (
    <div className="space-y-4">
      <div className={`${cardClass} flex flex-wrap items-center gap-3 p-4`}>
        <div className="relative min-w-0 flex-1 basis-56">
          {/* Positioned with logical properties so the icon stays on the
              reading-start edge in both directions, rather than pinned left. */}
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            style={{ insetInlineStart: "0.75rem" }}
          />
          <input
            type="search"
            className="h-10 w-full min-w-0 rounded-lg border border-input bg-transparent py-1 pe-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring focus-visible:ring-ring/50"
            style={{ paddingInlineStart: "2.25rem" }}
            placeholder="جست‌وجو در دسته، برچسب یا ویژگی…"
            aria-label="جست‌وجو در دسته‌بندی‌ها و ویژگی‌ها"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={refreshing}
          onClick={() => void load("refresh")}
          className="ms-auto"
        >
          <RefreshCwIcon className="size-4" aria-hidden="true" />
          {refreshing ? "در حال تازه‌سازی…" : "تازه‌سازی"}
        </Button>
      </div>

      {error ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs leading-5 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200"
        >
          <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      ) : null}

      {groups.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {[
            { label: "گروه", value: totals.groups },
            { label: "مورد", value: totals.terms },
            { label: "ویژگی", value: totals.attributes },
            { label: "محصول همگام‌شده", value: totals.mapped },
          ].map((chip) => (
            <span
              key={chip.label}
              className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground"
            >
              {chip.label}: <span className="font-medium text-foreground">{toPersianDigits(chip.value)}</span>
            </span>
          ))}
          <span className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
            آخرین همگام‌سازی: {syncedAt ? formatJalali(syncedAt, { withTime: true }) : "—"}
          </span>
        </div>
      ) : null}

      {groups.length === 0 && !error ? (
        <EmptyState>
          هنوز درخت دسته‌بندی دریافت نشده است. با «همگام‌سازی محصولات» در میز کار فروشگاه، دسته‌ها، برچسب‌ها و
          ویژگی‌های فروشگاه اینجا دیده می‌شوند.
        </EmptyState>
      ) : null}

      {groups.length > 0 && visible.length === 0 ? (
        <EmptyState>موردی با «{query}» پیدا نشد.</EmptyState>
      ) : null}

      {needle && visible.length > 0 ? (
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {toPersianDigits(hits)} مورد در {toPersianDigits(visible.length)} گروه پیدا شد.
        </p>
      ) : null}

      {visible.map((group) => {
        // Searching opens what it found; the disclosure state is only the
        // owner's collapse of a group they can see.
        const open = needle ? true : !closed[group.taxonomy];
        return (
          <SectionCard
            key={group.taxonomy}
            flush
            title={
              <span className="flex flex-wrap items-center gap-2">
                {group.isAttribute ? (
                  <TagsIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                ) : (
                  <FolderTreeIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                )}
                <span className="font-semibold text-foreground">{group.label}</span>
                {group.isAttribute ? <StatusBadge tone="active">ویژگی</StatusBadge> : null}
                <span dir="ltr" className="font-mono text-[11px] text-muted-foreground">
                  {group.taxonomy}
                </span>
              </span>
            }
            description={`${toPersianDigits(group.termCount)} مورد • ${toPersianDigits(
              group.mappedCount,
            )} محصول همگام‌شده`}
            actions={
              needle ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-expanded={open}
                  aria-controls={`taxonomy-${group.taxonomy}`}
                  onClick={() =>
                    setClosed((current) => ({ ...current, [group.taxonomy]: !current[group.taxonomy] }))
                  }
                >
                  {open ? "بستن" : "باز کردن"}
                  <ChevronDownIcon
                    aria-hidden="true"
                    className={`size-4 transition-transform duration-200 ease-out ${open ? "" : "-rotate-90"}`}
                  />
                </Button>
              )
            }
          >
            <div id={`taxonomy-${group.taxonomy}`} hidden={!open}>
              {group.terms.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground sm:px-5">
                  این گروه موردی ندارد.
                </p>
              ) : (
                <ul className="divide-y divide-border/80">
                  {group.terms.map((term) => (
                    <li
                      key={term.remoteId}
                      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2.5 sm:px-5"
                    >
                      <span className="flex min-w-0 items-center gap-1.5" style={indentStyle(term.depth)}>
                        {term.depth > 0 ? (
                          <span aria-hidden="true" className="text-muted-foreground">
                            └
                          </span>
                        ) : null}
                        <span className="min-w-0 truncate text-sm text-foreground">{term.name || "—"}</span>
                        {term.slug ? (
                          <span dir="ltr" className="hidden shrink-0 font-mono text-[10px] text-muted-foreground sm:inline">
                            {term.slug}
                          </span>
                        ) : null}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        در فروشگاه: {toPersianDigits(term.remoteCount)} • همگام‌شده:{" "}
                        {toPersianDigits(term.mappedCount)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </SectionCard>
        );
      })}
    </div>
  );
}
