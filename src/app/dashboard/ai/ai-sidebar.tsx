"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

/**
 * The assistant's own in-app navigation (Phase 36b revision).
 *
 * ChatGPT-style: a conversation list, a new-chat action, and a link to projects —
 * living here, inside the assistant, rather than in the customizable mobile
 * bottom bar the user builds for the rest of the product. On a phone this is the
 * drawer that replaces that bottom bar on the assistant page.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { FolderIcon, MessageSquarePlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "@/app/dashboard/ui";
import type { AiChatState } from "@/components/ai/use-ai-chat";

interface ConversationSummary {
  id: string;
  title: string;
  last_message_at: string;
}

export function AiSidebar({
  chat,
  onNavigate,
}: {
  chat: AiChatState;
  onNavigate: () => void;
}) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api<{ conversations: ConversationSummary[] }>("/api/ai/conversations?limit=50")
      .then(({ ok, data }) => {
        if (!cancelled && ok) setConversations(data.conversations ?? []);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex items-center justify-between border-b border-border/80 px-3 py-3">
        <span className="font-bold text-foreground">دستیار هوشمند</span>
        <button
          type="button"
          onClick={onNavigate}
          aria-label="بستن منو"
          className="grid size-9 place-items-center rounded-lg text-muted-foreground hover:bg-muted md:hidden"
        >
          <XIcon className="size-5" aria-hidden="true" />
        </button>
      </div>

      <div className="p-3">
        <Button
          variant="outline"
          className="w-full justify-start gap-2"
          onClick={() => {
            chat.startNewConversation();
            onNavigate();
          }}
        >
          <MessageSquarePlusIcon className="size-4" aria-hidden="true" />
          گفت‌وگوی جدید
        </Button>
      </div>

      <nav aria-label="مکالمه‌ها" className="min-w-0 flex-1 space-y-1 overflow-y-auto p-2">
        {loading ? (
          <LoadingSkeleton rows={4} compact className="px-2 py-3" />
        ) : conversations.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">هنوز مکالمه‌ای ثبت نشده است.</p>
        ) : (
          conversations.map((conversation) => {
            const active = conversation.id === chat.conversationId;
            return (
              <button
                key={conversation.id}
                type="button"
                onClick={() => {
                  void chat.loadConversation(conversation.id);
                  onNavigate();
                }}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "block w-full truncate rounded-lg px-3 py-2 text-start text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/40 dark:focus-visible:ring-amber-400/40",
                  active
                    ? "bg-amber-100 dark:bg-amber-500/20 font-semibold text-amber-950 dark:text-amber-200"
                    : "text-foreground/80 hover:bg-muted hover:text-foreground",
                )}
              >
                {conversation.title || "گفت‌وگوی بدون عنوان"}
              </button>
            );
          })
        )}
      </nav>

      <div className="border-t border-border/80 p-2">
        <Link
          href="/dashboard/projects"
          onClick={onNavigate}
          className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
        >
          <FolderIcon className="size-4 shrink-0" aria-hidden="true" />
          پروژه‌ها
        </Link>
      </div>
    </div>
  );
}
