"use client";

/**
 * The AI assistant's chat surface — a ChatGPT-style column (Phase 36b
 * revision, redesigned again in Phase 36c with the shared bubble/composer
 * components).
 *
 * A slim header (nav toggle + new chat), a scrollable bubble thread, and the
 * shared composer pinned to the bottom of the column. The welcome state is a
 * hero with floating gradient orbs and task-aware starter cards. The
 * conversation state can be owned by a parent (AiWorkspace) or, when rendered
 * standalone, created here.
 */

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { MenuIcon, MessageSquarePlusIcon, SparklesIcon } from "lucide-react";
import { LoadingSkeleton } from "../page-chrome";
import { useGSAP } from "@gsap/react";
import { useMoney } from "@/components/money/money-context";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useFeatureLocked } from "@/components/feature-lock";
import { ChatComposer } from "@/components/ai/chat-composer";
import { ChatBubble } from "@/components/ai/chat-bubble";
import { animateFloat, animateStaggerIn } from "@/components/ai/chat-animations";
import { SUGGESTED_PROMPTS, taskById, taskSuggestions } from "@/lib/ai-tasks";
import { useAiChat, type AiChatState } from "@/components/ai/use-ai-chat";
import { cardClass } from "../page-chrome";

export function AiChatHub({
  chat: externalChat,
  onOpenNav,
}: {
  chat?: AiChatState;
  /** Shown on phones to open the assistant's own side nav (conversations/projects). */
  onOpenNav?: () => void;
}) {
  const locked = useFeatureLocked();
  const internalChat = useAiChat({ mode: "dashboard" });
  const chat = externalChat ?? internalChat;

  const searchParams = useSearchParams();
  const money = useMoney();
  const scrollRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const orbLeftRef = useRef<HTMLDivElement>(null);
  const orbRightRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);

  const {
    canPropose,
    messages,
    input,
    setInput,
    busy,
    applyingId,
    loadingConversation,
    attachments,
    attachFiles,
    clearAttachment,
    actionsAllowed,
    setActionsAllowed,
    task,
    setTask,
    customTask,
    setCustomTask,
    ensureGreeting,
    startNewConversation,
    loadConversation,
    sendMessage,
    askAgain,
    applyProposal,
    dismissProposal,
    submitInputRequest,
    dismissInputRequest,
  } = chat;

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

  // Hero choreography: cards stagger up while two gradient orbs drift.
  useGSAP(
    () => {
      if (!isWelcome) return;
      if (heroRef.current) animateStaggerIn(heroRef.current, "[data-hero]");
      if (orbLeftRef.current) animateFloat(orbLeftRef.current, { x: 24, y: -18 }, 7);
      if (orbRightRef.current) animateFloat(orbRightRef.current, { x: -30, y: 22 }, 9);
    },
    { scope: heroRef, dependencies: [isWelcome] },
  );

  const suggestions = taskSuggestions(task, "dashboard", SUGGESTED_PROMPTS.dashboard);
  const taskLabel = task === "custom" && customTask ? "وظیفهٔ سفارشی" : taskById(task)?.label;

  return (
    <section className="flex h-full min-h-0 w-full flex-col">
      <header className="flex min-h-12 items-center gap-2 border-b border-border/80 bg-card/80 backdrop-blur px-2 py-1.5 backdrop-blur sm:px-3">
        {onOpenNav ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={onOpenNav}
            aria-label="منوی دستیار"
            className="md:hidden"
          >
            <MenuIcon />
          </Button>
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">دستیار هوشمند</p>
          {taskLabel ? (
            <p className="truncate text-[10px] text-muted-foreground">وظیفهٔ فعلی: {taskLabel}</p>
          ) : null}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={startNewConversation}
          className="gap-1.5 px-2.5 sm:px-3"
        >
          <MessageSquarePlusIcon className="size-4 shrink-0" aria-hidden="true" />
          <span className="hidden sm:inline">گفت‌وگوی جدید</span>
        </Button>
      </header>

      <div ref={scrollRef} className="ai-chat-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-4 sm:px-6">
        {loadingConversation ? (
          <LoadingSkeleton
            rows={6}
            className="mx-auto w-full max-w-3xl py-6"
            label="در حال بازکردن مکالمه"
          />
        ) : isWelcome ? (
          <div ref={heroRef} className="relative mx-auto flex min-h-[60vh] max-w-3xl flex-col items-center justify-center overflow-hidden text-center">
            {/* Drifting gradient orbs — pure decoration. */}
            <div
              ref={orbLeftRef}
              aria-hidden="true"
              className="pointer-events-none absolute -top-10 right-[12%] size-56 rounded-full bg-primary/15 blur-3xl"
            />
            <div
              ref={orbRightRef}
              aria-hidden="true"
              className="pointer-events-none absolute bottom-0 left-[8%] size-44 rounded-full bg-amber-300/20 dark:bg-amber-500/35 blur-3xl"
            />

            <div
              data-hero
              className="grid size-16 place-items-center rounded-3xl bg-gradient-to-br from-primary to-primary/70 text-primary-foreground shadow-[0_1px_2px_rgb(41_37_36/0.035)]"
            >
              <SparklesIcon className="size-8" aria-hidden />
            </div>
            <h1
              data-hero
              className="mt-6 bg-gradient-to-b from-foreground to-foreground/60 bg-clip-text text-2xl font-bold tracking-tight text-transparent sm:text-[1.8rem]"
            >
              امروز چطور می‌توانم کمکتان کنم؟
            </h1>
            <p data-hero className="mt-2 text-sm leading-6 text-muted-foreground">
              درباره فروش، موجودی، هزینه‌ها و عملکرد کسب‌وکارتان سؤال کنید — یا
              وظیفهٔ دستیار را از کادر پایین عوض کنید.
            </p>
            <div data-hero className="mt-8 grid w-full gap-3 sm:grid-cols-3">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => void sendMessage(suggestion)}
                  className={cn(
                    cardClass,
                    "min-h-24 p-4 text-start text-sm leading-6 text-foreground/80 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring focus-visible:ring-amber-400/40 dark:focus-visible:ring-amber-400/40",
                  )}
                >
                  <span className="mb-3 grid size-8 place-items-center rounded-xl bg-amber-100/70 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300">
                    <SparklesIcon className="size-4" aria-hidden />
                  </span>
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-3xl space-y-5">
            {messages.map((message, index) => {
              if (index === 0 && message.role === "assistant") return null;
              return (
                <ChatBubble
                  key={message.id}
                  message={message}
                  busy={busy && index === messages.length - 1}
                  canPropose={canPropose}
                  applyingId={applyingId}
                  formatCost={(rial) => money.format(rial)}
                  applyProposal={applyProposal}
                  dismissProposal={dismissProposal}
                  submitInputRequest={submitInputRequest}
                  dismissInputRequest={dismissInputRequest}
                  onAskAgain={
                    message.cacheNotice
                      ? () => {
                          const question = messages
                            .slice(0, Math.max(0, index))
                            .reverse()
                            .find((item) => item.role === "user")?.content;
                          if (question) void askAgain(question);
                        }
                      : undefined
                  }
                />
              );
            })}
          </div>
        )}
      </div>

      <div className="border-t border-border/80 bg-card/80 backdrop-blur px-2 py-2 backdrop-blur sm:px-4 sm:py-3">
        <div className="mx-auto max-w-3xl">
          <ChatComposer
            variant="page"
            mode="dashboard"
            input={input}
            setInput={setInput}
            busy={busy || loadingConversation}
            canPropose={canPropose}
            attachments={attachments}
            onAttachFiles={(files) => void attachFiles(files)}
            onClearAttachment={clearAttachment}
            task={task}
            onTaskChange={setTask}
            customTask={customTask}
            onCustomTaskChange={setCustomTask}
            actionsAllowed={actionsAllowed}
            setActionsAllowed={setActionsAllowed}
            loadConversation={loadConversation}
            sendMessage={sendMessage}
            footer={
              <p className="mt-2 text-center text-[11px] text-muted-foreground">
                پاسخ‌ها بر اساس داده‌های ثبت‌شده کسب‌وکار شما ارائه می‌شوند.
              </p>
            }
          />
        </div>
      </div>
    </section>
  );
}
