import { RefObject } from "react";
import { Loader2Icon } from "lucide-react";
import { cn } from "@/lib/utils";
import { AiProposalCard } from "./ai-proposal-card";
import {
  SUGGESTED_PROMPTS,
  type AiChatMessage,
  type AssistantMode,
  type PendingTurn,
} from "./use-ai-chat";

interface AiChatMessagesProps {
  mode: AssistantMode;
  messages: AiChatMessage[];
  busy: boolean;
  estimating: boolean;
  pending: PendingTurn | null;
  canPropose: boolean;
  applyingId?: string | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  applyProposal: (message: AiChatMessage) => void;
  dismissProposal: (message: AiChatMessage) => void;
  prepareSend: (prompt?: string) => void;
}

export function AiChatMessages({
  mode,
  messages,
  busy,
  estimating,
  pending,
  canPropose,
  applyingId,
  scrollRef,
  applyProposal,
  dismissProposal,
  prepareSend,
}: AiChatMessagesProps) {
  const showSuggestions =
    messages.length === 1 &&
    messages[0]?.role === "assistant" &&
    !busy &&
    !estimating &&
    !pending;

  return (
    <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
      {messages.map((message) => (
        <div
          key={message.id}
          className={cn(
            "flex",
            message.role === "user" ? "justify-start" : "justify-end",
          )}
        >
          <div className="max-w-[85%] space-y-2">
            <div
              className={cn(
                "whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm leading-relaxed",
                message.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-foreground",
              )}
            >
              {message.content ||
                (busy ? (
                  <span className="text-muted-foreground">
                    در حال دریافت پاسخ…
                  </span>
                ) : null)}
            </div>
            {canPropose && message.proposal ? (
              <AiProposalCard
                proposal={message.proposal}
                applied={message.applied}
                applying={applyingId === message.id}
                onApply={() => void applyProposal(message)}
                onDismiss={() => dismissProposal(message)}
              />
            ) : null}
          </div>
        </div>
      ))}

      {showSuggestions ? (
        <div className="rounded-xl border border-dashed bg-muted/30 p-2.5">
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            برای شروع، یکی را انتخاب کنید:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTED_PROMPTS[mode].map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => void prepareSend(suggestion)}
                className="rounded-full border bg-background px-2.5 py-1.5 text-right text-[11px] leading-4 transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {busy ? (
        <div className="flex justify-end">
          <div className="flex items-center gap-2 rounded-2xl bg-muted px-3 py-2 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" /> پاسخ به‌صورت زنده در
            حال دریافت است…
          </div>
        </div>
      ) : null}
    </div>
  );
}
