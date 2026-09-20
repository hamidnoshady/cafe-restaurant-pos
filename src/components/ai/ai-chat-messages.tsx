"use client";

/**
 * The floating launcher's message thread — a stack of `ChatBubble`s plus the
 * starter chips shown while the conversation is still just the greeting.
 */
import { useRef, type RefObject } from "react";
import { useGSAP } from "@gsap/react";
import { ChatBubble, TypingDots } from "./chat-bubble";
import { animateStaggerIn } from "./chat-animations";
import type { AiChatMessage } from "./use-ai-chat";
import type { InputResponse } from "@/lib/ai-input-protocol";

export { TypingDots };

interface AiChatMessagesProps {
  messages: AiChatMessage[];
  busy: boolean;
  canPropose: boolean;
  applyingId?: string | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Starter chips — the caller picks task-aware ones. */
  suggestions?: string[];
  applyProposal: (message: AiChatMessage) => void;
  dismissProposal: (message: AiChatMessage) => void;
  submitInputRequest?: (message: AiChatMessage, response: InputResponse) => void;
  dismissInputRequest?: (message: AiChatMessage) => void;
  sendMessage: (prompt?: string) => void;
  /** Phase 36 Wave 7 — «دوباره بپرس» on a cached answer. */
  askAgain?: (text: string) => void;
}

export function AiChatMessages({
  messages,
  busy,
  canPropose,
  applyingId,
  scrollRef,
  suggestions,
  applyProposal,
  dismissProposal,
  submitInputRequest,
  dismissInputRequest,
  sendMessage,
  askAgain,
}: AiChatMessagesProps) {
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const showSuggestions =
    messages.length === 1 && messages[0]?.role === "assistant" && !busy && (suggestions?.length ?? 0) > 0;

  useGSAP(
    () => {
      if (suggestionsRef.current) animateStaggerIn(suggestionsRef.current, "[data-suggestion]");
    },
    { scope: suggestionsRef, dependencies: [showSuggestions] },
  );

  return (
    <div ref={scrollRef} className="ai-chat-scroll flex-1 space-y-4 overflow-y-auto px-3 py-4">
      {messages.map((message, index) => (
        <ChatBubble
          key={message.id}
          message={message}
          busy={busy && index === messages.length - 1}
          canPropose={canPropose}
          applyingId={applyingId}
          applyProposal={applyProposal}
          dismissProposal={dismissProposal}
          submitInputRequest={submitInputRequest}
          dismissInputRequest={dismissInputRequest}
          onAskAgain={
            message.cacheNotice && askAgain
              ? () => {
                  const question = messages
                    .slice(0, Math.max(0, index))
                    .reverse()
                    .find((item) => item.role === "user")?.content;
                  if (question) askAgain(question);
                }
              : undefined
          }
        />
      ))}

      {showSuggestions && suggestions ? (
        <div ref={suggestionsRef} className="rounded-2xl border border-dashed border-border/70 bg-muted/30 p-3">
          <p className="mb-2 px-1 text-[11px] font-medium text-muted-foreground">
            برای شروع، یکی را انتخاب کنید:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                data-suggestion
                type="button"
                onClick={() => void sendMessage(suggestion)}
                className="rounded-full border border-border/80 bg-background px-3 py-1.5 text-right text-[11px] leading-4 text-foreground/80 transition-all hover:border-primary/40 hover:bg-primary/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
