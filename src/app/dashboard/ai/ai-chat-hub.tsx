"use client";

/**
 * Conversation-first AI home. The assistant intentionally has no page tabs,
 * agent cards, or recent-conversation rail: business questions are the primary
 * action, while receipts, saved conversations, and report prompts remain
 * available as compact composer tools.
 */
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2Icon, MessageSquarePlusIcon, SendIcon, SparklesIcon } from "lucide-react";
import { useMoney } from "@/components/money/money-context";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useFeatureLocked } from "@/components/feature-lock";
import { AiAttachmentChip, AiComposerTools } from "@/components/ai/ai-composer-tools";
import { AiMarkdown } from "@/components/ai/ai-markdown";
import { TypingDots } from "@/components/ai/ai-chat-messages";
import { AiProposalCard } from "@/components/ai/ai-proposal-card";
import { SUGGESTED_PROMPTS, useAiChat } from "@/components/ai/use-ai-chat";
import { cardClass } from "../page-chrome";

export function AiChatHub() {
  const locked = useFeatureLocked();
  const searchParams = useSearchParams();
  const money = useMoney();
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const [composerFocused, setComposerFocused] = useState(false);

  const {
    canPropose,
    messages,
    input,
    setInput,
    busy,
    applyingId,
    loadingConversation,
    attachment,
    attachReceiptImage,
    clearAttachment,
    actionsAllowed,
    setActionsAllowed,
    ensureGreeting,
    startNewConversation,
    loadConversation,
    sendMessage,
    applyProposal,
    dismissProposal,
  } = useAiChat({ mode: "dashboard" });

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const requested = locked ? null : searchParams.get("conversation");
    const ctx = searchParams.get("ctx");
    if (ctx) {
      setInput(ctx);
      ensureGreeting();
    } else if (requested) {
      void loadConversation(requested);
    } else {
      ensureGreeting();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const isWelcome =
    messages.length === 1 && messages[0]?.role === "assistant" && !busy && !loadingConversation;

  return (
    <section className="relative mx-auto flex min-h-[calc(100dvh-var(--app-bottom-nav)-1rem)] w-full max-w-5xl flex-col md:min-h-[calc(100vh-2rem)]">
      <div className="absolute start-0 top-0 z-10">
        <Button variant="outline" size="icon" onClick={startNewConversation} aria-label="گفتگوی جدید" title="گفتگوی جدید">
          <MessageSquarePlusIcon />
        </Button>
      </div>

      <div ref={scrollRef} className="min-w-0 flex-1 overflow-y-auto px-1 pb-52 pt-16 sm:px-6">
        {loadingConversation ? (
          <div className="flex min-h-[55vh] items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" /> در حال بازکردن مکالمه…
          </div>
        ) : isWelcome ? (
          <div className="mx-auto flex min-h-[52vh] max-w-3xl flex-col items-center justify-center text-center">
            <div className="grid size-14 place-items-center rounded-2xl bg-primary/10 text-primary">
              <SparklesIcon className="size-7" aria-hidden />
            </div>
            <h1 className="mt-5 text-2xl font-bold tracking-tight text-stone-950 sm:text-[1.7rem]">
              امروز چطور می‌توانم کمکتان کنم؟
            </h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              درباره فروش، موجودی، هزینه‌ها و عملکرد کسب‌وکارتان سؤال کنید.
            </p>
            <div className="mt-8 grid w-full gap-3 sm:grid-cols-3">
              {SUGGESTED_PROMPTS.dashboard.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => void sendMessage(suggestion)}
                  className={cn(cardClass, "min-h-24 p-4 text-start text-sm leading-6 text-stone-700 transition-colors hover:bg-stone-50 hover:text-stone-950 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-amber-400/40")}
                >
                  <span className="mb-3 grid size-8 place-items-center rounded-xl bg-amber-100/70 text-amber-700">
                    <SparklesIcon className="size-4" aria-hidden />
                  </span>
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-3xl space-y-6">
            {messages.map((message, index) => {
              if (index === 0 && message.role === "assistant") return null;
              return (
                <div key={message.id} className={cn("flex min-w-0", message.role === "user" ? "justify-start" : "justify-end")}>
                  <div className="min-w-0 max-w-[88%] space-y-2 sm:max-w-[82%]">
                    <div
                      className={cn(
                        "min-w-0 overflow-hidden text-sm leading-7",
                        message.role === "user"
                          ? "rounded-2xl bg-primary px-4 py-2.5 text-primary-foreground"
                          : "px-1 text-foreground",
                      )}
                    >
                      {message.role === "user" ? message.content : message.content ? <AiMarkdown content={message.content} /> : <TypingDots />}
                    </div>
                    {message.role === "assistant" && typeof message.costRial === "number" && message.costRial > 0 ? (
                      <p className="px-1 text-[10px] text-muted-foreground">هزینهٔ این پاسخ: {money.format(message.costRial)}</p>
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
              );
            })}
          </div>
        )}
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-2 bg-gradient-to-t from-background via-background via-80% to-transparent px-1 pt-12 sm:px-6 md:bottom-0">
        <div className="pointer-events-auto mx-auto max-w-3xl">
          <AiAttachmentChip attachment={attachment} onClear={clearAttachment} />
          <div
            className={cn(
              "rounded-2xl border bg-card p-3 shadow-[0_1px_2px_rgb(41_37_36/0.035)] transition-colors",
              composerFocused ? "border-ring ring-3 ring-ring/50" : "border-stone-200/80",
            )}
          >
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onFocus={() => setComposerFocused(true)}
              onBlur={() => setComposerFocused(false)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendMessage();
                }
              }}
              rows={2}
              disabled={busy || loadingConversation}
              placeholder="پیام خود را بنویسید…"
              className="max-h-40 min-h-14 w-full resize-none bg-transparent px-1 py-1 text-sm leading-6 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
            />
            <div className="mt-2 flex items-end justify-between gap-2">
              <AiComposerTools
                mode="dashboard"
                canPropose={canPropose}
                disabled={busy || loadingConversation}
                onAttach={(file) => void attachReceiptImage(file)}
                actionsAllowed={actionsAllowed}
                onActionsAllowedChange={setActionsAllowed}
                onSelectConversation={(id) => void loadConversation(id)}
                onSelectReportPrompt={(prompt) => setInput(prompt)}
              />
              <Button size="icon" onClick={() => void sendMessage()} disabled={busy || !input.trim() || loadingConversation} aria-label="ارسال پیام">
                <SendIcon className="rtl:-scale-x-100" />
              </Button>
            </div>
          </div>
          <p className="mt-2 text-center text-[11px] text-muted-foreground">
            پاسخ‌ها بر اساس داده‌های ثبت‌شده کسب‌وکار شما ارائه می‌شوند.
          </p>
        </div>
      </div>
    </section>
  );
}
