import { RefObject } from "react";
import { cn } from "@/lib/utils";
import { AiMarkdown } from "./ai-markdown";
import { AiProposalCard } from "./ai-proposal-card";
import { SUGGESTED_PROMPTS, type AiChatMessage, type AssistantMode } from "./use-ai-chat";

interface AiChatMessagesProps {
  mode: AssistantMode;
  messages: AiChatMessage[];
  busy: boolean;
  canPropose: boolean;
  applyingId?: string | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  applyProposal: (message: AiChatMessage) => void;
  dismissProposal: (message: AiChatMessage) => void;
  sendMessage: (prompt?: string) => void;
}

/** Three dots, not a sentence — a chat says "typing", it does not narrate. */
export function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1" aria-label="در حال نوشتن">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="size-1.5 animate-bounce rounded-full bg-current opacity-60"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

export function AiChatMessages({
  mode,
  messages,
  busy,
  canPropose,
  applyingId,
  scrollRef,
  applyProposal,
  dismissProposal,
  sendMessage,
}: AiChatMessagesProps) {
  const showSuggestions =
    messages.length === 1 && messages[0]?.role === "assistant" && !busy;

  return (
    <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
      {messages.map((message) => (
        <div
          key={message.id}
          className={cn("flex min-w-0", message.role === "user" ? "justify-start" : "justify-end")}
        >
          <div className="min-w-0 max-w-[85%] space-y-2">
            <div
              className={cn(
                "min-w-0 overflow-hidden rounded-2xl px-3 py-2 text-sm leading-relaxed",
                message.role === "user"
                  ? "whitespace-pre-wrap break-words bg-primary text-primary-foreground"
                  : "bg-muted text-foreground",
              )}
            >
              {message.role === "user" ? (
                message.content
              ) : message.content ? (
                <AiMarkdown content={message.content} />
              ) : (
                <TypingDots />
              )}
            </div>
            {/* The charge, after the fact and in passing — never a gate in front
                of the reply. See sendMessage in use-ai-chat.ts. */}
            {message.role === "assistant" && typeof message.costRial === "number" && message.costRial > 0 ? (
              <p className="px-1 text-[10px] text-muted-foreground">
                هزینهٔ این پاسخ: {Math.round(message.costRial / 10).toLocaleString("fa-IR")} تومان
              </p>
            ) : null}
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
                onClick={() => void sendMessage(suggestion)}
                className="rounded-full border bg-background px-2.5 py-1.5 text-right text-[11px] leading-4 transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
