import Link from "next/link";
import { BotIcon, ExternalLinkIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AssistantMode } from "./use-ai-chat";

interface AiChatHeaderProps {
  mode: AssistantMode;
  conversationId?: string | null;
  onClose: () => void;
}

export function AiChatHeader({
  mode,
  conversationId,
  onClose,
}: AiChatHeaderProps) {
  const fullPageHref = conversationId
    ? `/dashboard/ai?conversation=${conversationId}`
    : "/dashboard/ai";

  return (
    <header className="flex items-center justify-between border-b bg-primary/5 px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="flex size-8 items-center justify-center rounded-full bg-primary/15 text-primary">
          <BotIcon className="size-4.5" />
        </span>
        <div>
          <p className="text-sm font-bold leading-tight">دستیار هوشمند</p>
          <p className="text-[11px] text-muted-foreground">
            {mode === "wizard"
              ? "کمک به راه‌اندازی"
              : mode === "floor"
                ? "منو و صورت‌حساب؛ فقط‌خواندنی"
                : "گزارش‌ها و کارها"}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1">
        {mode === "dashboard" ? (
          <Button
            variant="ghost"
            size="icon-sm"
            asChild
            aria-label="بازکردن در صفحهٔ کامل"
          >
            <Link href={fullPageHref}>
              <ExternalLinkIcon />
            </Link>
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label="بستن"
        >
          <XIcon />
        </Button>
      </div>
    </header>
  );
}
