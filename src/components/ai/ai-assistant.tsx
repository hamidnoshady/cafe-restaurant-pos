"use client";

/**
 * Floating AI launcher — the chat core (streaming, proposals, conversation
 * persistence, task lens) lives in `useAiChat` and is shared with the
 * /dashboard/ai hub; this component is the small popup window plus a link
 * that hands the same conversation off to the full-page hub.
 *
 * Phase 36c redesign: on phones it opens as a full bottom sheet with a dimmer
 * (chat-app behaviour), on larger screens as a window that springs out of the
 * launcher's corner. Both paths are GSAP-animated and honour
 * prefers-reduced-motion.
 */
import { useEffect, useRef, useState } from "react";
import { SparklesIcon } from "lucide-react";
import { useGSAP } from "@gsap/react";
import { AiChatHeader } from "./ai-chat-header";
import { AiChatMessages } from "./ai-chat-messages";
import { AiChatInput } from "./ai-chat-input";
import { useAiChat, type AssistantMode } from "./use-ai-chat";
import { SUGGESTED_PROMPTS, taskById, taskSuggestions } from "@/lib/ai-tasks";
import {
  animateBackdropIn,
  animateBackdropOut,
  animateBadgeBump,
  animatePanelIn,
  animatePanelOut,
} from "./chat-animations";

interface Props {
  mode: AssistantMode;
  currentStep?: string | null;
}

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 639px)");
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return mobile;
}

export function AiAssistant({ mode, currentStep }: Props) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [unseenCount, setUnseenCount] = useState(0);
  const isMobile = useIsMobile();
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const badgeRef = useRef<HTMLSpanElement>(null);
  const {
    canPropose,
    messages,
    input,
    setInput,
    busy,
    applyingId,
    conversationId,
    attachments,
    attachFiles,
    clearAttachment,
    actionsAllowed,
    setActionsAllowed,
    task,
    setTask,
    customTask,
    setCustomTask,
    agentId,
    setAgentId,
    ensureGreeting,
    startNewConversation,
    loadConversation,
    sendMessage,
    askAgain,
    applyProposal,
    dismissProposal,
    submitInputRequest,
    dismissInputRequest,
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

  // Launcher entrance + badge bump.
  useGSAP(
    () => {
      if (launcherRef.current) {
        animatePanelIn(launcherRef.current, { fromBottomSheet: false });
      }
    },
    { scope: launcherRef },
  );
  useGSAP(
    () => {
      if (badgeRef.current && unseenCount > 0) animateBadgeBump(badgeRef.current);
    },
    { scope: badgeRef, dependencies: [unseenCount] },
  );

  // Panel + backdrop entrance.
  useGSAP(
    () => {
      if (!open) return;
      if (panelRef.current) animatePanelIn(panelRef.current, { fromBottomSheet: isMobile });
      if (isMobile && backdropRef.current) animateBackdropIn(backdropRef.current);
    },
    { scope: panelRef, dependencies: [open, isMobile] },
  );

  function close() {
    if (closing) return;
    setClosing(true);
    const finish = () => {
      setOpen(false);
      setClosing(false);
    };
    if (panelRef.current) {
      animatePanelOut(panelRef.current, { fromBottomSheet: isMobile }, finish);
    } else {
      finish();
    }
    if (isMobile && backdropRef.current) animateBackdropOut(backdropRef.current);
  }

  const suggestions = taskSuggestions(task, mode, SUGGESTED_PROMPTS[mode]);
  const taskLabel =
    task === "custom" && customTask
      ? "وظیفهٔ سفارشی"
      : taskById(task)?.label;

  return (
    <>
      {!open && (
        <button
          ref={launcherRef}
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
          className="fixed bottom-[calc(var(--app-bottom-nav)+var(--app-bottom-dock)+0.75rem)] left-4 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary/80 text-primary-foreground opacity-70 shadow-[0_12px_32px_-6px_rgb(41_37_36/0.25)] ring-1 ring-foreground/10 transition-[transform,opacity] hover:scale-105 hover:opacity-100 focus-visible:opacity-100 active:scale-95 active:opacity-100 md:bottom-5 md:left-5"
        >
          <SparklesIcon className="size-6" />
          {unseenCount > 0 && (
            <span
              ref={badgeRef}
              className="absolute -end-1 -top-1 flex min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-[11px] font-semibold text-destructive-foreground ring-2 ring-background"
            >
              {unseenCount > 9 ? "۹+" : unseenCount.toLocaleString("fa-IR")}
            </span>
          )}
        </button>
      )}

      {open && (
        <>
          {/* Phone dimmer — the sheet is modal, like every chat app's. */}
          <div
            ref={backdropRef}
            aria-hidden="true"
            onClick={close}
            className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] sm:hidden"
          />

          <div
            ref={panelRef}
            role="dialog"
            aria-label="دستیار هوشمند"
            className="fixed z-50 flex flex-col overflow-hidden rounded-3xl border border-border/80 bg-card shadow-[0_12px_32px_-6px_rgb(41_37_36/0.18)] ring-1 ring-foreground/10
              inset-x-0 bottom-0 h-[min(88dvh,720px)] rounded-t-3xl border-t

              sm:inset-x-auto sm:bottom-[calc(var(--app-bottom-nav)+var(--app-bottom-dock)+0.75rem)] sm:left-4 sm:h-[min(76dvh,660px)] sm:w-[min(94vw,420px)] sm:rounded-3xl sm:border md:bottom-5 md:left-5"
          >
            {/* Grab handle, phones only. */}
            <div className="flex justify-center pt-2 sm:hidden" aria-hidden="true">
              <span className="h-1.5 w-10 rounded-full bg-input" />
            </div>

            <AiChatHeader
              mode={mode}
              conversationId={conversationId}
              taskLabel={mode === "wizard" ? undefined : taskLabel}
              busy={busy}
              onNewChat={startNewConversation}
              onClose={close}
            />
            <AiChatMessages
              messages={messages}
              busy={busy}
              canPropose={canPropose}
              applyingId={applyingId}
              scrollRef={scrollRef}
              suggestions={suggestions}
              applyProposal={applyProposal}
              dismissProposal={dismissProposal}
              submitInputRequest={submitInputRequest}
              dismissInputRequest={dismissInputRequest}
              sendMessage={sendMessage}
              askAgain={askAgain}
            />
            <AiChatInput
              mode={mode}
              input={input}
              setInput={setInput}
              busy={busy}
              canPropose={canPropose}
              attachments={attachments}
              onAttachFiles={(files) => void attachFiles(files)}
              onClearAttachment={clearAttachment}
              task={task}
              onTaskChange={setTask}
              customTask={customTask}
              onCustomTaskChange={setCustomTask}
              agentId={agentId}
              onAgentChange={setAgentId}
              actionsAllowed={actionsAllowed}
              setActionsAllowed={setActionsAllowed}
              loadConversation={loadConversation}
              sendMessage={sendMessage}
            />
          </div>
        </>
      )}
    </>
  );
}
