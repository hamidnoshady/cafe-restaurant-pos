"use client";

/**
 * Floating AI launcher. The chat core (streaming, cost preview, propose→
 * confirm, conversation persistence) lives in `useAiChat` and is shared with
 * the `/dashboard/ai` hub (Wave 2, issue #142); this component is just the
 * small popup window plus a link that hands the same conversation off to the
 * full-page hub.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  BotIcon,
  ExternalLinkIcon,
  Loader2Icon,
  SendIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { formatToman } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AiProposalCard } from "./ai-proposal-card";
import { SUGGESTED_PROMPTS, useAiChat, type AssistantMode } from "./use-ai-chat";

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
    ensureGreeting,
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
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy, pending]);

  useEffect(() => {
    function prefill(event: Event) {
      const detail = (event as CustomEvent<{ prompt?: unknown }>).detail;
      const prompt = typeof detail?.prompt === "string" ? detail.prompt.trim().slice(0, 8_000) : "";
      if (!prompt) return;
      setOpen(true);
      setInput(prompt);
    }
    window.addEventListener("ai:prefill", prefill);
    return () => window.removeEventListener("ai:prefill", prefill);
  }, [setInput]);

  const showSuggestions =
    messages.length === 1 &&
    messages[0]?.role === "assistant" &&
    !busy &&
    !estimating &&
    !pending;

  const fullPageHref = conversationId ? `/dashboard/ai?conversation=${conversationId}` : "/dashboard/ai";

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
        <div className="fixed bottom-5 left-5 z-50 flex h-[min(74vh,610px)] w-[min(92vw,410px)] flex-col overflow-hidden rounded-2xl border bg-card shadow-2xl ring-1 ring-foreground/10">
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
                <Button variant="ghost" size="icon-sm" asChild aria-label="بازکردن در صفحهٔ کامل">
                  <Link href={fullPageHref}>
                    <ExternalLinkIcon />
                  </Link>
                </Button>
              ) : null}
              <Button variant="ghost" size="icon-sm" onClick={() => setOpen(false)} aria-label="بستن">
                <XIcon />
              </Button>
            </div>
          </header>

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
            {messages.map((message) => (
              <div key={message.id} className={cn("flex", message.role === "user" ? "justify-start" : "justify-end")}>
                <div className="max-w-[85%] space-y-2">
                  <div
                    className={cn(
                      "whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm leading-relaxed",
                      message.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-foreground",
                    )}
                  >
                    {message.content || (busy ? <span className="text-muted-foreground">در حال دریافت پاسخ…</span> : null)}
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
                <p className="mb-2 text-xs font-medium text-muted-foreground">برای شروع، یکی را انتخاب کنید:</p>
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
                  <Loader2Icon className="size-4 animate-spin" /> پاسخ به‌صورت زنده در حال دریافت است…
                </div>
              </div>
            ) : null}
          </div>

          <div className="border-t p-2">
            {pending ? (
              <div className="mb-2 rounded-xl border border-primary/25 bg-primary/5 p-2.5 text-xs">
                <p className="font-semibold text-foreground">
                  برآورد هزینه: {formatToman(pending.estimate.estimatedCostRial)}
                </p>
                <p className="mt-1 leading-5 text-muted-foreground">
                  بر پایهٔ {pending.estimate.assumedToolRounds} نوبت پاسخ/ابزار محاسبه شده است. حداکثر رزرو این درخواست: {formatToman(pending.estimate.maximumReservationRial)}؛ مبلغ نهایی بر اساس مصرف واقعی تسویه می‌شود.
                </p>
                <div className="mt-2 flex gap-2">
                  <Button size="sm" onClick={() => void startStream(pending.text)} disabled={busy}>
                    <SendIcon className="rtl:-scale-x-100" /> شروع پاسخ
                  </Button>
                  <Button size="sm" variant="ghost" onClick={cancelPending} disabled={busy}>
                    ویرایش
                  </Button>
                </div>
              </div>
            ) : null}
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void prepareSend();
                  }
                }}
                rows={1}
                disabled={busy || estimating || Boolean(pending)}
                placeholder={estimating ? "در حال محاسبهٔ برآورد…" : "پیام خود را بنویسید…"}
                className="max-h-28 min-h-9 flex-1 resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/30"
              />
              <Button
                size="icon"
                onClick={() => void prepareSend()}
                disabled={busy || estimating || Boolean(pending) || !input.trim()}
                aria-label="نمایش برآورد هزینه"
              >
                {estimating ? <Loader2Icon className="animate-spin" /> : <SendIcon className="rtl:-scale-x-100" />}
              </Button>
            </div>
            {mode === "floor" ? (
              <p className="mt-1 px-1 text-[10px] text-muted-foreground">
                این دستیار فقط راهنمایی و پیش‌نمایش می‌دهد؛ هیچ پرداخت، تقسیم یا تغییری ثبت نمی‌شود.
              </p>
            ) : (
              <p className="mt-1 px-1 text-[10px] text-muted-foreground">
                هزینهٔ تخمینی پیش از ارسال نشان داده می‌شود؛ تغییرها فقط با تأیید شما ثبت می‌شوند.{" "}
                <Link href="/dashboard/ai?tab=settings" className="underline underline-offset-2 hover:text-foreground">
                  اعتبار، اشتراک و گزارش ممیزی
                </Link>
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
