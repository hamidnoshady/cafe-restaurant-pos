"use client";

/**
 * Floating AI launcher. The chat core (streaming, cost preview, propose→
 * confirm, conversation persistence) lives in `useAiChat` and is shared with
 * the `/dashboard/ai` hub (Wave 2, issue #142); this component is just the
 * small popup window plus a link that hands the same conversation off to the
 * full-page hub.
 */
import { useEffect, useRef, useState } from "react";
import { SparklesIcon } from "lucide-react";
import { AiChatHeader } from "./ai-chat-header";
import { AiChatMessages } from "./ai-chat-messages";
import { AiChatInput } from "./ai-chat-input";
import { useAiChat, type AssistantMode } from "./use-ai-chat";

interface Props {
  mode: AssistantMode;
  currentStep?: string | null;
}

export function AiAssistant({ mode, currentStep }: Props) {
  const [open, setOpen] = useState(false);
  const [unseenCount, setUnseenCount] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const {
    canPropose,
    messages,
    input,
    setInput,
    busy,
    applyingId,
    conversationId,
    attachment,
    attachReceiptImage,
    clearAttachment,
    actionsAllowed,
    setActionsAllowed,
    ensureGreeting,
    loadConversation,
    sendMessage,
    askAgain,
    applyProposal,
    dismissProposal,
  } = useAiChat({ mode, currentStep });

  useEffect(() => {
    if (open) ensureGreeting();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, busy]);

  useEffect(() => {
    function prefill(event: Event) {
      const detail = (event as CustomEvent<{ prompt?: unknown }>).detail;
      const prompt =
        typeof detail?.prompt === "string"
          ? detail.prompt.trim().slice(0, 8_000)
          : "";
      if (!prompt) return;
      setOpen(true);
      setInput(prompt);
    }
    window.addEventListener("ai:prefill", prefill);
    return () => window.removeEventListener("ai:prefill", prefill);
  }, [setInput]);

  // Phase 31 — how an owner learns an unattended action ran. There is no
  // notification channel in this product, so the launcher carries the count and
  // the AI hub's activity list is where it gets read. Dashboard mode only:
  // floor mode has no autopilot surface at all.
  useEffect(() => {
    if (mode !== "dashboard") return;
    let cancelled = false;
    async function refresh() {
      if (document.visibilityState !== "visible") return;
      try {
        // Phase 32 — one badge, two sources. A coworker run waiting for the
        // owner's yes is the same kind of "the assistant needs you" as an
        // autopilot action, and two competing badges on one launcher would
        // just teach people to ignore both.
        const [activity, runs] = await Promise.all([
          fetch("/api/ai/autopilot/activity?countOnly=1"),
          fetch("/api/ai/coworker/runs?status=pending_approval&limit=1"),
        ]);
        let total = 0;
        if (activity.ok) {
          const body = (await activity.json()) as { unseenCount?: number };
          total += Number(body.unseenCount ?? 0);
        }
        if (runs.ok) {
          const body = (await runs.json()) as { pendingCount?: number };
          total += Number(body.pendingCount ?? 0);
        }
        if (!cancelled) setUnseenCount(total);
      } catch {
        // A badge is not worth surfacing an error for.
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 5 * 60 * 1000);
    const clear = () => setUnseenCount(0);
    window.addEventListener("ai:autopilot-seen", clear);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("ai:autopilot-seen", clear);
    };
  }, [mode]);

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={unseenCount > 0 ? `دستیار هوشمند — ${unseenCount} مورد نیازمند توجه شما` : "دستیار هوشمند"}
          /*
            On a phone the button sits *above* the fixed bottom bar rather than
            on top of it — it used to cover a nav entry, and the entry it
            covered depended on which pages the member had put in the bar. It
            clears whatever the page has docked on that bar too (the sell
            screen's cart summary), via `--app-bottom-dock` in globals.css.
            It also rests translucent so it stops hiding whatever is under it,
            and comes to full strength on touch/hover/focus, so the control you
            are actually reaching for is the solid one.
          */
          className="fixed bottom-[calc(var(--app-bottom-nav)+var(--app-bottom-dock)+0.75rem)] left-4 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground opacity-70 shadow-lg ring-1 ring-foreground/10 transition-[transform,opacity] hover:scale-105 hover:opacity-100 focus-visible:opacity-100 active:scale-95 active:opacity-100 md:bottom-5 md:left-5"
        >
          <SparklesIcon className="size-6" />
          {unseenCount > 0 && (
            <span className="absolute -end-1 -top-1 flex min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-[11px] font-semibold text-destructive-foreground ring-2 ring-background">
              {unseenCount > 9 ? "۹+" : unseenCount.toLocaleString("fa-IR")}
            </span>
          )}
        </button>
      )}

      {open && (
        <div className="fixed bottom-[calc(var(--app-bottom-nav)+var(--app-bottom-dock)+0.75rem)] left-4 z-50 flex h-[min(68dvh,610px)] w-[min(92vw,410px)] flex-col overflow-hidden rounded-2xl border border-stone-200/80 bg-card shadow-2xl ring-1 ring-foreground/10 md:bottom-5 md:left-5 md:h-[min(74vh,610px)]">
          <AiChatHeader
            mode={mode}
            conversationId={conversationId}
            onClose={() => setOpen(false)}
          />
          <AiChatMessages
            mode={mode}
            messages={messages}
            busy={busy}
            canPropose={canPropose}
            applyingId={applyingId}
            scrollRef={scrollRef}
            applyProposal={applyProposal}
            dismissProposal={dismissProposal}
            sendMessage={sendMessage}
            askAgain={askAgain}
          />
          <AiChatInput
            mode={mode}
            input={input}
            setInput={setInput}
            busy={busy}
            canPropose={canPropose}
            attachment={attachment}
            actionsAllowed={actionsAllowed}
            setActionsAllowed={setActionsAllowed}
            attachReceiptImage={attachReceiptImage}
            clearAttachment={clearAttachment}
            loadConversation={loadConversation}
            sendMessage={sendMessage}
          />
        </div>
      )}
    </>
  );
}
