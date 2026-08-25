"use client";

/**
 * `/dashboard/ai` hub (Wave 2, issue #142): main chat panel + recent
 * conversations sidebar on the "chat" tab, existing credit/proactive/audit
 * settings moved under the "settings" tab. Chat logic is the same
 * `useAiChat` core the floating launcher uses.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
import { AiActionAudit } from "./ai-action-audit";
import { AiCoworkerPanel } from "./ai-coworker-panel";
import { AiAgentCards, type AgentTodayTask } from "./ai-agent-cards";
import { AiBillingDashboard } from "./ai-billing";
import { AiProactiveSettings } from "./ai-proactive-settings";
import { AiAutopilotSettings } from "./ai-autopilot-settings";
import { AiAutopilotActivity } from "./ai-autopilot-activity";
import { AiRecentConversations } from "./ai-recent-conversations";
import { AiTodayTasks } from "./ai-today-tasks";
import { cardClass, type Tab } from "../page-chrome";
import { SectionNav } from "../section-nav";

type HubTab = "chat" | "coworker" | "settings";

const HUB_TABS: readonly Tab<HubTab>[] = [
  { key: "chat", label: "چت هوش مصنوعی" },
  // Phase 32 — second, not last: after the first week an owner comes here to
  // clear the inbox far more often than to chat.
  { key: "coworker", label: "همکار هوشمند" },
  { key: "settings", label: "تنظیمات" },
];

function isHubTab(value: string | null): value is HubTab {
  return value === "chat" || value === "coworker" || value === "settings";
}

export function AiChatHub({ canAutoApply }: { canAutoApply: boolean }) {
  const locked = useFeatureLocked();
  const router = useRouter();
  const searchParams = useSearchParams();
  const money = useMoney();
  const [tab, setTab] = useState<HubTab>(() => {
    const requested = searchParams.get("tab");
    return isHubTab(requested) ? requested : "chat";
  });
  const [conversationsKey, setConversationsKey] = useState(0);
  const [todayTasks, setTodayTasks] = useState<AgentTodayTask[] | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);

  const {
    canPropose,
    messages,
    input,
    setInput,
    busy,
    applyingId,
    conversationId,
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
  } = useAiChat({
    mode: "dashboard",
    onConversationIdChange: () => setConversationsKey((key) => key + 1),
  });

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    // The greeting is local, so a locked preview still opens on a real-looking
    // chat; reopening a stored conversation is a request, and would only 403.
    const requested = locked ? null : searchParams.get("conversation");
    if (requested) void loadConversation(requested);
    else ensureGreeting();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  function selectTab(next: HubTab) {
    setTab(next);
    const params = new URLSearchParams(searchParams.toString());
    if (next === "chat") params.delete("tab");
    else params.set("tab", next);
    params.delete("conversation");
    router.replace(`/dashboard/ai${params.toString() ? `?${params.toString()}` : ""}`, { scroll: false });
  }

  const showSuggestions =
    messages.length === 1 && messages[0]?.role === "assistant" && !busy && !loadingConversation;

  return (
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <SectionNav idPrefix="ai" label="بخش‌های هوش مصنوعی" sections={HUB_TABS} active={tab} onChange={selectTab}>
      {tab === "chat" ? (
        <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
          <section className={cn("flex h-[min(70dvh,720px)] flex-col overflow-hidden md:h-[min(78vh,720px)]", cardClass)}>
            <div ref={scrollRef} className="min-w-0 flex-1 space-y-3 overflow-y-auto p-4">
              {loadingConversation ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2Icon className="size-4 animate-spin" /> در حال بازکردن مکالمه…
                </p>
              ) : (
                <>
                  {messages.map((message) => (
                    <div
                      key={message.id}
                      className={cn("flex min-w-0", message.role === "user" ? "justify-start" : "justify-end")}
                    >
                      <div className="min-w-0 max-w-[85%] space-y-2">
                        <div
                          className={cn(
                            "min-w-0 overflow-hidden rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed",
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
                        {message.role === "assistant" &&
                        typeof message.costRial === "number" &&
                        message.costRial > 0 ? (
                          <p className="px-1 text-[10px] text-muted-foreground">
                            هزینهٔ این پاسخ: {money.format(message.costRial)}
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
                    <div className="rounded-xl border border-dashed bg-muted/30 p-4">
                      <p className="mb-3 text-sm font-medium text-muted-foreground">
                        برای شروع، یکی از این‌ها را انتخاب کنید:
                      </p>
                      <div className="grid gap-2 sm:grid-cols-3">
                        {SUGGESTED_PROMPTS.dashboard.map((suggestion) => (
                          <button
                            key={suggestion}
                            type="button"
                            onClick={() => void sendMessage(suggestion)}
                            className="rounded-xl border bg-background p-3 text-right text-xs leading-5 transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <SparklesIcon className="mb-1.5 size-4 text-primary" />
                            {suggestion}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </>
              )}
            </div>

            <div className="border-t border-stone-200/80 p-3">
              <AiAttachmentChip attachment={attachment} onClear={clearAttachment} />
              <div className="mb-2">
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
              </div>
              <div className="flex items-end gap-2">
                <textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void sendMessage();
                    }
                  }}
                  rows={2}
                  disabled={busy || loadingConversation}
                  placeholder="پیام خود را بنویسید…"
                  className="max-h-40 min-h-11 flex-1 resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/30"
                />
                <Button
                  size="icon"
                  onClick={() => void sendMessage()}
                  disabled={busy || !input.trim() || loadingConversation}
                  aria-label="ارسال پیام"
                >
                  <SendIcon className="rtl:-scale-x-100" />
                </Button>
              </div>
              <p className="mt-1 px-1 text-[11px] text-muted-foreground">
                هزینهٔ هر پاسخ زیر همان پاسخ نوشته می‌شود؛ تغییرها فقط با تأیید شما ثبت می‌شوند.
              </p>
            </div>
          </section>

          <aside className="flex flex-col gap-3">
            <Button variant="outline" onClick={startNewConversation} className="justify-start">
              <MessageSquarePlusIcon /> گفتگوی جدید
            </Button>
            <AiAgentCards onTodayTasksChange={setTodayTasks} />
            <AiTodayTasks tasks={todayTasks} />
            <AiRecentConversations
              activeId={conversationId}
              refreshKey={conversationsKey}
              onSelect={(id) => void loadConversation(id)}
            />
          </aside>
        </div>
      ) : tab === "coworker" ? (
        <AiCoworkerPanel canAutoApply={canAutoApply} />
      ) : (
        <div className="mx-auto w-full max-w-2xl space-y-5">
          <AiProactiveSettings />
          {/* Autopilot sits directly under the proactive opt-in it depends on,
              so the dependency is legible rather than buried in copy. */}
          <AiAutopilotSettings />
          <AiAutopilotActivity />
          <AiBillingDashboard />
          <AiActionAudit />
        </div>
      )}
      </SectionNav>
    </div>
  );
}
