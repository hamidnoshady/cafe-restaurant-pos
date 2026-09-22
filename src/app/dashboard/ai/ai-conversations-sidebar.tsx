"use client";

/**
 * «گفتگوهای اخیر» — the chat history sidebar (Part 1 of the AI rebuild).
 *
 * This is the ONE home for conversation history: recent threads, search,
 * rename, delete and continue, for the signed-in member's own dashboard
 * conversations (ownership is enforced by the API, exactly as before). It
 * lives on the chat page's END side — visually the LEFT column in RTL — and
 * replaced the retired «نخ‌های اخیر» widget that used to sit in the workspace
 * rail, so the rail carries no chat navigation of its own any more.
 *
 * Data interactions are deliberately boring REST: list on mount/open/change,
 * PATCH to rename, DELETE to remove. Every state is visible — skeleton while
 * loading, an explicit empty state, a toast on failure — never a silent gap.
 */
import { useCallback, useEffect, useState } from "react";
import {
  CheckIcon,
  MessageSquareIcon,
  PencilIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { LoadingSkeleton } from "../page-chrome";
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
  return new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

export function AiConversationsSidebar({
  activeId,
  /** Bumped by the parent when a new conversation may have been created. */
  refreshToken,
  onSelect,
  onDeleted,
  onRenamed,
  onClose,
  /** `inline` = the desktop column; the mobile sheet renders the same list with a close button. */
  variant = "inline",
}: {
  activeId: string | null;
  refreshToken: number;
  onSelect: (id: string) => void;
  onDeleted?: (id: string) => void;
  onRenamed?: (conversation: ConversationSummary) => void;
  onClose?: () => void;
  variant?: "inline" | "sheet";
}) {
  const [items, setItems] = useState<ConversationSummary[] | null>(null);
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const locked = useFeatureLocked();

  const reload = useCallback(async () => {
    if (locked) {
      setItems([]);
      return;
    }
    try {
      const response = await fetch("/api/ai/conversations");
      const data = (await response.json().catch(() => ({}))) as {
        conversations?: ConversationSummary[];
        error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "خواندن گفتگوهای اخیر ممکن نشد.");
      setItems((data.conversations ?? []).filter((item) => item.mode === "dashboard"));
    } catch (reason) {
      setItems([]);
      toast.error(reason instanceof Error ? reason.message : "خواندن گفتگوهای اخیر ممکن نشد.");
    }
  }, [locked]);

  useEffect(() => {
    void reload();
  }, [reload, refreshToken]);

  const filtered = (items ?? []).filter((item) =>
    query.trim() ? item.title.includes(query.trim()) : true,
  );

  async function submitRename(id: string) {
    const title = renameValue.replace(/\s+/g, " ").trim();
    if (!title) {
      toast.error("عنوان گفتگو نمی‌تواند خالی باشد.");
      return;
    }
    setBusyId(id);
    try {
      const response = await fetch(`/api/ai/conversations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        conversation?: ConversationSummary;
        error?: string;
        message?: string;
      };
      if (!response.ok || !data.conversation) {
        throw new Error(data.message ?? "تغییر نام ممکن نشد.");
      }
      const renamed = data.conversation;
      setItems((current) =>
        (current ?? []).map((item) => (item.id === renamed.id ? { ...item, title: renamed.title } : item)),
      );
      onRenamed?.(renamed);
      setRenamingId(null);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "تغییر نام ممکن نشد.");
    } finally {
      setBusyId(null);
    }
  }

  async function removeConversation(id: string) {
    // The first tap arms the trash button for THIS row; the second tap (or a
    // different row) is the confirmation. No window.confirm — the pattern
    // stays inside the design system and works the same on a touch screen.
    if (deletingId !== id) {
      setDeletingId(id);
      return;
    }
    setBusyId(id);
    try {
      const response = await fetch(`/api/ai/conversations/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("حذف گفتگو ممکن نشد.");
      setItems((current) => (current ?? []).filter((item) => item.id !== id));
      onDeleted?.(id);
      toast.success("گفتگو حذف شد.");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "حذف گفتگو ممکن نشد.");
    } finally {
      setDeletingId(null);
      setBusyId(null);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border/80 px-3 py-2.5">
        <MessageSquareIcon aria-hidden="true" className="size-4 shrink-0 text-primary" />
        <p className="min-w-0 flex-1 text-sm font-semibold text-foreground">گفتگوهای اخیر</p>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="بستن گفتگوهای اخیر"
            className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45"
          >
            <XIcon className="size-4" />
          </button>
        ) : null}
      </div>

      <div className="px-2.5 py-2">
        <div className="relative">
          <SearchIcon
            aria-hidden="true"
            className="absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="جست‌وجوی گفتگو…"
            aria-label="جست‌وجوی گفتگو"
            className="w-full rounded-lg border border-border/80 bg-card py-1.5 pe-2.5 ps-8 text-xs outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-amber-400/60 focus-visible:ring-2 focus-visible:ring-amber-500/30"
          />
        </div>
      </div>

      <div className="ai-chat-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {items === null ? (
          <LoadingSkeleton rows={5} className="px-1 py-2" label="در حال خواندن گفتگوها" />
        ) : filtered.length === 0 ? (
          <div className="px-2 py-8 text-center">
            <MessageSquareIcon aria-hidden="true" className="mx-auto size-8 text-muted-foreground/40" />
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {query.trim()
                ? "گفتگویی با این عنوان پیدا نشد."
                : "هنوز گفتگویی ثبت نشده است.\nاولین پرسش خود را بپرسید."}
            </p>
          </div>
        ) : (
          <ul className="space-y-0.5">
            {filtered.map((item) => {
              const active = item.id === activeId;
              const renaming = renamingId === item.id;
              return (
                <li key={item.id}>
                  {renaming ? (
                    <div className="flex items-center gap-1 rounded-lg border border-amber-300/70 bg-amber-50/60 px-1.5 py-1 dark:border-amber-500/30 dark:bg-amber-500/10">
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void submitRename(item.id);
                          }
                          if (event.key === "Escape") setRenamingId(null);
                        }}
                        aria-label="عنوان جدید گفتگو"
                        className="min-w-0 flex-1 bg-transparent px-1 py-0.5 text-xs outline-none"
                        maxLength={60}
                      />
                      <button
                        type="button"
                        onClick={() => void submitRename(item.id)}
                        disabled={busyId === item.id}
                        aria-label="ذخیرهٔ عنوان"
                        className="grid size-6 shrink-0 place-items-center rounded-md text-emerald-700 transition-colors hover:bg-emerald-500/15 dark:text-emerald-300"
                      >
                        <CheckIcon className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setRenamingId(null)}
                        aria-label="انصراف"
                        className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted"
                      >
                        <XIcon className="size-3.5" />
                      </button>
                    </div>
                  ) : (
                    <div
                      className={cn(
                        "group/conv flex items-start gap-1 rounded-lg px-1.5 py-1.5 transition-colors",
                        active
                          ? "bg-amber-100 dark:bg-amber-500/20"
                          : "hover:bg-amber-50 dark:hover:bg-amber-500/10",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => onSelect(item.id)}
                        title={item.title}
                        className="min-w-0 flex-1 text-start focus-visible:outline-none"
                      >
                        <span
                          className={cn(
                            "block truncate text-xs font-medium leading-5",
                            active ? "text-amber-700 dark:text-amber-300" : "text-foreground/80",
                          )}
                        >
                          {item.title}
                        </span>
                        <span className="block text-[10px] leading-4 text-muted-foreground">
                          {formatDate(item.lastMessageAt)}
                        </span>
                      </button>
                      <span className="flex shrink-0 items-center gap-0.5 pt-0.5 opacity-0 transition-opacity group-hover/conv:opacity-100 focus-within:opacity-100">
                        <button
                          type="button"
                          onClick={() => {
                            setRenamingId(item.id);
                            setRenameValue(item.title);
                          }}
                          aria-label={`تغییر نام «${item.title}»`}
                          title="تغییر نام"
                          className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                          <PencilIcon className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void removeConversation(item.id)}
                          disabled={busyId === item.id}
                          aria-label={
                            deletingId === item.id
                              ? `تأیید حذف «${item.title}»`
                              : `حذف «${item.title}»`
                          }
                          title={deletingId === item.id ? "برای تأیید دوباره بزنید" : "حذف"}
                          className={cn(
                            "grid size-6 place-items-center rounded-md transition-colors",
                            deletingId === item.id
                              ? "bg-red-500/15 text-red-700 dark:text-red-300"
                              : "text-muted-foreground hover:bg-muted hover:text-red-700 dark:hover:text-red-300",
                          )}
                        >
                          <Trash2Icon className="size-3.5" />
                        </button>
                      </span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {variant === "sheet" ? null : (
        <p className="border-t border-border/80 px-3 py-2 text-[10px] leading-4 text-muted-foreground">
          گفتگوها فقط برای شما قابل مشاهده‌اند.
        </p>
      )}
    </div>
  );
}
