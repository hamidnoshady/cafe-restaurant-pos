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
  const scrollRef = useRef<HTMLDivElement>(null);
  const {
    canPropose,
    messages,
    input,
    setInput,
    busy,
    estimating,
    pending,
    applyingId,
    conversationId,
    attachment,
    attachReceiptImage,
    clearAttachment,
    actionsAllowed,
    setActionsAllowed,
    ensureGreeting,
    loadConversation,
    prepareSend,
    cancelPending,
    startStream,
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
  }, [messages, busy, pending]);

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

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="دستیار هوشمند"
          className="fixed bottom-5 left-5 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg ring-1 ring-foreground/10 transition-transform hover:scale-105 active:scale-95"
        >
          <SparklesIcon className="size-6" />
        </button>
      )}

      {open && (
        <div className="fixed bottom-5 left-5 z-50 flex h-[min(74vh,610px)] w-[min(92vw,410px)] flex-col overflow-hidden rounded-2xl border border-stone-200/80 bg-card shadow-2xl ring-1 ring-foreground/10">
          <AiChatHeader
            mode={mode}
            conversationId={conversationId}
            onClose={() => setOpen(false)}
          />
          <AiChatMessages
            mode={mode}
            messages={messages}
            busy={busy}
            estimating={estimating}
            pending={pending}
            canPropose={canPropose}
            applyingId={applyingId}
            scrollRef={scrollRef}
            applyProposal={applyProposal}
            dismissProposal={dismissProposal}
            prepareSend={prepareSend}
          />
          <AiChatInput
            mode={mode}
            input={input}
            setInput={setInput}
            busy={busy}
            estimating={estimating}
            pending={pending}
            canPropose={canPropose}
            attachment={attachment}
            actionsAllowed={actionsAllowed}
            setActionsAllowed={setActionsAllowed}
            attachReceiptImage={attachReceiptImage}
            clearAttachment={clearAttachment}
            loadConversation={loadConversation}
            prepareSend={prepareSend}
            cancelPending={cancelPending}
            startStream={startStream}
          />
        </div>
      )}
    </>
  );
}
