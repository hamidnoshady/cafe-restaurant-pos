"use client";

/**
 * The floating window's header — ChatGPT-style identity row: gradient avatar
 * with a live status dot, the assistant's name, the active task lens under
 * it, and the window actions (new chat, open in the hub, close).
 */
import Link from "next/link";
import { BotIcon, ExternalLinkIcon, MessageSquarePlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AssistantMode } from "./use-ai-chat";

interface AiChatHeaderProps {
  mode: AssistantMode;
  conversationId?: string | null;
  /** The active task lens label, shown under the name. */
  taskLabel?: string;
  busy?: boolean;
  onNewChat?: () => void;
  onClose: () => void;
}

export function AiChatHeader({
  mode,
  conversationId,
  taskLabel,
  busy,
  onNewChat,
  onClose,
}: AiChatHeaderProps) {
  const fullPageHref = conversationId
    ? `/dashboard/ai?conversation=${conversationId}`
    : "/dashboard/ai";

  const modeLabel =
    mode === "wizard"
      ? "کمک به راه‌اندازی"
      : mode === "floor"
        ? "منو و صورت‌حساب؛ فقط‌خواندنی"
        : "گزارش‌ها و کارها";

  return (
    <header className="flex items-center gap-2.5 border-b border-stone-200/70 bg-gradient-to-b from-primary/10 to-transparent px-3.5 py-2.5 dark:border-stone-700/50">
      <span className="relative grid size-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary via-primary to-primary/70 text-primary-foreground shadow-md shadow-primary/30">
        <BotIcon className="size-4.5" />
        <span
          aria-hidden="true"
          className={`absolute -bottom-0.5 -end-0.5 size-3 rounded-full border-2 border-background ${
            busy ? "bg-amber-400 animate-pulse" : "bg-emerald-500"
          }`}
        />
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-bold leading-tight">دستیار هوشمند</p>
        <p className="truncate text-[11px] text-muted-foreground">
          {busy ? "در حال نوشتن…" : "آنلاین · آمادهٔ پاسخ"}
          {taskLabel ? ` · ${taskLabel}` : ""}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {onNewChat ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onNewChat}
            aria-label="گفت‌وگوی جدید"
            title="گفت‌وگوی جدید"
          >
            <MessageSquarePlusIcon />
          </Button>
        ) : null}
        {mode === "dashboard" ? (
          <Button
            variant="ghost"
            size="icon-sm"
            asChild
            aria-label="بازکردن در صفحهٔ کامل"
            title="بازکردن در صفحهٔ کامل"
          >
            <Link href={fullPageHref}>
              <ExternalLinkIcon />
            </Link>
          </Button>
        ) : null}
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="بستن">
          <XIcon />
        </Button>
      </div>
      <span className="sr-only">{modeLabel}</span>
    </header>
  );
}
