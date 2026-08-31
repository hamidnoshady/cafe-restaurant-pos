"use client";

import { useEffect, useState } from "react";
import { ChevronDownIcon, ChevronUpIcon, MessageSquareIcon } from "lucide-react";
import { LoadingSkeleton } from "../page-chrome";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useFeatureLocked } from "@/components/feature-lock";

interface ConversationSummary {
  id: string;
  mode: "wizard" | "dashboard" | "floor";
  title: string;
  lastMessageAt: string;
  createdAt: string;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

/**
 * This member's recent hub conversations, as a compact sidebar widget.
 *
 * Two behaviours keep a long history from owning the sidebar: the list starts
 * with only `initialLimit` threads and grows one `initialLimit` at a time
 * («نمایش بیشتر» / «نمایش کمتر»), and the whole block collapses into its
 * header row when `collapsible` (the workspace rail passes it).
 */
export function AiRecentConversations({
  activeId,
  refreshKey,
  onSelect,
  initialLimit = 5,
  collapsible = false,
}: {
  activeId: string | null;
  refreshKey: number;
  onSelect: (id: string) => void;
  /** How many threads to show before «نمایش بیشتر». */
  initialLimit?: number;
  /** Whether the header row collapses the list. */
  collapsible?: boolean;
}) {
  const [items, setItems] = useState<ConversationSummary[] | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [visibleCount, setVisibleCount] = useState(initialLimit);
  const locked = useFeatureLocked();

  useEffect(() => {
    let cancelled = false;
    if (locked) {
      setItems([]);
      return;
    }
    fetch("/api/ai/conversations")
      .then(async (response) => {
        const data = (await response.json().catch(() => ({}))) as {
          conversations?: ConversationSummary[];
          error?: string;
        };
        if (!response.ok) throw new Error(data.error ?? "خواندن گفتگوهای اخیر ممکن نشد.");
        return data.conversations ?? [];
      })
      .then((conversations) => {
        if (!cancelled) setItems(conversations.filter((item) => item.mode === "dashboard"));
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setItems([]);
          toast.error(reason instanceof Error ? reason.message : "خواندن گفتگوهای اخیر ممکن نشد.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey, locked]);

  const hasMore = items !== null && visibleCount < items.length;
  const visible = items === null ? [] : items.slice(0, visibleCount);

  return (
    <section aria-label="نخ‌های اخیر" className="space-y-1">
      <button
        type="button"
        aria-expanded={collapsible ? !collapsed : undefined}
        onClick={collapsible ? () => setCollapsed((current) => !current) : undefined}
        className={cn(
          "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors",
          collapsible && "hover:bg-amber-50 dark:hover:bg-amber-500/15 hover:text-amber-700 dark:hover:text-amber-300",
        )}
      >
        <MessageSquareIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-start">نخ‌های اخیر</span>
        {collapsible ? (
          <ChevronDownIcon
            aria-hidden="true"
            className={cn("size-3.5 shrink-0 transition-transform", collapsed && "rtl:-rotate-90 ltr:rotate-90")}
          />
        ) : null}
      </button>

      {collapsed ? null : items === null ? (
        <LoadingSkeleton rows={3} className="px-2 py-1.5" label="در حال خواندن گفتگوها" />
      ) : items.length === 0 ? (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">هنوز گفتگویی ثبت نشده است.</p>
      ) : (
        <>
          <ul className="space-y-0.5">
            {visible.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onSelect(item.id)}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-right text-xs transition-colors hover:bg-amber-50 dark:hover:bg-amber-500/15 hover:text-amber-700 dark:hover:text-amber-300",
                    activeId === item.id ? "bg-amber-100 dark:bg-amber-500/20 font-medium text-amber-700 dark:text-amber-300" : "text-foreground/80",
                  )}
                >
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-input" aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{item.title}</span>
                    <span className="block text-[10px] text-muted-foreground">{formatDate(item.lastMessageAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {hasMore ? (
            <button
              type="button"
              onClick={() => setVisibleCount((count) => Math.min(items.length, count + initialLimit))}
              className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-300 transition-colors hover:bg-amber-50 dark:hover:bg-amber-500/15"
            >
              <ChevronDownIcon aria-hidden="true" className="size-3.5 shrink-0" />
              نمایش بیشتر
            </button>
          ) : null}
          {visibleCount > initialLimit ? (
            <button
              type="button"
              onClick={() => setVisibleCount(initialLimit)}
              className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground/80"
            >
              <ChevronUpIcon aria-hidden="true" className="size-3.5 shrink-0" />
              نمایش کمتر
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
