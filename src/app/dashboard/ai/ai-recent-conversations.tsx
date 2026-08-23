"use client";

import { useEffect, useState } from "react";
import { Loader2Icon, MessageSquareIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useFeatureLocked } from "@/components/feature-lock";
import { cardClass } from "../page-chrome";

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

/** Wave 2 (issue #142) hub sidebar: this member's own recent hub conversations (Wave 1, issue #141). */
export function AiRecentConversations({
  activeId,
  refreshKey,
  onSelect,
}: {
  activeId: string | null;
  refreshKey: number;
  onSelect: (id: string) => void;
}) {
  const [items, setItems] = useState<ConversationSummary[] | null>(null);
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
        if (!cancelled) toast.error(reason instanceof Error ? reason.message : "خواندن گفتگوهای اخیر ممکن نشد.");
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey, locked]);

  return (
    <section className={cn("flex flex-1 flex-col overflow-hidden", cardClass)}>
      <header className="border-b border-stone-200/80 px-3 py-2.5">
        <p className="text-sm font-semibold text-stone-950">گفتگوهای اخیر</p>
      </header>
      <div className="max-h-[50vh] overflow-y-auto p-1.5 lg:max-h-none">
        {items === null ? (
          <p className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" /> در حال خواندن…
          </p>
        ) : items.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">هنوز گفتگویی ثبت نشده است.</p>
        ) : (
          <ul className="space-y-1">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onSelect(item.id)}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-right text-xs transition-colors hover:bg-muted",
                    activeId === item.id ? "bg-primary/10 text-primary" : "text-foreground",
                  )}
                >
                  <MessageSquareIcon className="mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{item.title}</span>
                    <span className="block text-[10px] text-muted-foreground">{formatDate(item.lastMessageAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
