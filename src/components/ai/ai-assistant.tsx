"use client";

/**
 * Floating AI assistant. Wave 5 adds a deliberate cost preview, suggested
 * prompts, provider-streamed text and a tenant-scoped audit outcome for every
 * confirmed proposal; it does not widen the existing action allowlist.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  BotIcon,
  CheckIcon,
  Loader2Icon,
  SendIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { ACTION_CATALOG, resolveActionEndpoint, type ProposedAction } from "@/lib/ai";
import { formatToman } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type AssistantMode = "wizard" | "dashboard" | "floor";

interface Msg {
  id: string;
  role: "user" | "assistant";
  content: string;
  proposal?: ProposedAction | null;
  auditId?: string | null;
  applied?: boolean;
}

interface Props {
  mode: AssistantMode;
  currentStep?: string | null;
}

interface TurnEstimate {
  estimatedCostRial: number;
  maximumReservationRial: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  assumedToolRounds: number;
  hasTools: boolean;
}

interface PendingTurn {
  text: string;
  estimate: TurnEstimate;
}

const uid = () => Math.random().toString(36).slice(2);

const CHAT_ERROR: Record<string, string> = {
  ai_credit_required: "اعتبار هوش مصنوعی برای یک پاسخ جدید کافی نیست. از صفحهٔ اعتبار درخواست شارژ ثبت کنید.",
  ai_unavailable: "سرویس هوش مصنوعی هنوز توسط مدیر پلتفرم آماده نشده است.",
  feature_disabled: "دستیار هوشمند برای این کسب‌وکار فعال نیست.",
  ai_auth: "اتصال سراسری سرویس هوش مصنوعی نیاز به بررسی مدیر پلتفرم دارد.",
  ai_timeout: "پاسخ سرویس دیر رسید. دوباره تلاش کنید.",
  ai_network: "اتصال به سرویس هوش مصنوعی برقرار نشد.",
  ai_provider: "سرویس هوش مصنوعی خطا داد. بعداً تلاش کنید.",
  empty_messages: "پیامی برای ارسال نیست.",
};

const SUGGESTED_PROMPTS: Record<AssistantMode, string[]> = {
  wizard: [
    "برای تکمیل این مرحله چه اطلاعاتی لازم است؟",
    "یک منوی اولیهٔ ساده برای کافه پیشنهاد بده.",
    "تنظیمات مالیات و روش قیمت‌گذاری را بررسی کن.",
  ],
  dashboard: [
    "فروش هفتهٔ اخیر را خلاصه و با هفتهٔ قبل مقایسه کن.",
    "کدام آیتم‌های منو عملکرد ضعیف‌تری دارند؟",
    "موجودی کم و پیشنهادهای خرید را بررسی کن.",
  ],
  floor: [
    "مواد اولیهٔ ثبت‌شدهٔ یک آیتم منو را بگو.",
    "صورت‌حساب میز ۳ را برای ۴ نفر تقسیم کن.",
    "برای سؤال حساسیت غذایی چه داده‌ای ثبت شده است؟",
  ],
};

function greeting(mode: AssistantMode): string {
  if (mode === "wizard") {
    return "سلام! من دستیار راه‌اندازی هستم. بگویید کافه یا رستوران‌تان چه ویژگی‌هایی دارد تا با هم فیلدهای هر مرحله را کامل کنیم. هر تغییری قبل از ثبت، تأیید شما را لازم دارد.";
  }
  if (mode === "floor") {
    return "سلام! می‌توانم دربارهٔ منوی شعبه، مواد اولیهٔ ثبت‌شده و پیش‌نمایش تقسیم برابر صورت‌حساب کمک کنم. هیچ تغییری ثبت نمی‌کنم؛ برای موارد حساسیت غذایی، دادهٔ ثبت‌نشده را حدس نمی‌زنم.";
  }
  return "سلام! می‌توانم گزارش‌های فروش، منو، موجودی و حسابداری را نشان دهم، وضعیت راه‌اندازی را بررسی کنم و کارهای مجاز را با تأیید شما انجام دهم. چه کمکی از من برمی‌آید؟";
}

function errorMessage(data: Record<string, unknown>): string {
  return CHAT_ERROR[String(data.error ?? "")] ??
    (typeof data.message === "string" ? data.message : "خطا در ارتباط با دستیار.");
}

function isEstimate(value: unknown): value is TurnEstimate {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.estimatedCostRial === "number" &&
    typeof item.maximumReservationRial === "number" &&
    typeof item.assumedToolRounds === "number"
  );
}

export function AiAssistant({ mode, currentStep }: Props) {
  const router = useRouter();
  const canPropose = mode === "wizard" || mode === "dashboard";
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [estimating, setEstimating] = useState(false);
  const [pending, setPending] = useState<PendingTurn | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && messages.length === 0) {
      setMessages([{ id: uid(), role: "assistant", content: greeting(mode) }]);
    }
  }, [open, mode, messages.length]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy, pending]);

  useEffect(() => {
    function prefill(event: Event) {
      const detail = (event as CustomEvent<{ prompt?: unknown }>).detail;
      const prompt = typeof detail?.prompt === "string" ? detail.prompt.trim().slice(0, 8_000) : "";
      if (!prompt) return;
      setOpen(true);
      setPending(null);
      setInput(prompt);
    }
    window.addEventListener("ai:prefill", prefill);
    return () => window.removeEventListener("ai:prefill", prefill);
  }, []);

  async function prepareSend(textOverride?: string) {
    const text = (textOverride ?? input).trim();
    if (!text || busy || estimating || pending) return;

    const candidateHistory = [...messages, { id: uid(), role: "user" as const, content: text }];
    setEstimating(true);
    try {
      const response = await fetch("/api/ai/estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          currentStep: currentStep ?? null,
          messages: candidateHistory.map((message) => ({ role: message.role, content: message.content })),
        }),
      });
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok || !isEstimate(data)) throw new Error(errorMessage(data));
      setInput("");
      setPending({ text, estimate: data });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "محاسبهٔ برآورد هزینه ممکن نشد.");
    } finally {
      setEstimating(false);
    }
  }

  async function startStream(text: string) {
    if (busy) return;
    const userMsg: Msg = { id: uid(), role: "user", content: text };
    const replyId = uid();
    const history = [...messages, userMsg];
    setMessages([...history, { id: replyId, role: "assistant", content: "" }]);
    setPending(null);
    setBusy(true);

    function setReply(update: (current: Msg) => Msg) {
      setMessages((current) => current.map((message) => (message.id === replyId ? update(message) : message)));
    }

    function receiveEvent(block: string): boolean {
      let event = "message";
      let data = "";
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) return false;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(data) as Record<string, unknown>;
      } catch {
        return false;
      }

      if (event === "delta" && typeof payload.content === "string") {
        setReply((current) => ({ ...current, content: current.content + payload.content }));
        return false;
      }
      if (event === "reset") {
        setReply((current) => ({ ...current, content: "" }));
        return false;
      }
      if (event === "done") {
        setReply((current) => ({
          ...current,
          content: typeof payload.content === "string" ? payload.content : current.content,
          proposal: canPropose ? (payload.proposedAction as ProposedAction | null | undefined) ?? null : null,
          auditId: typeof payload.auditId === "string" ? payload.auditId : null,
        }));
        return true;
      }
      if (event === "error") {
        setReply((current) => ({ ...current, content: "⚠️ " + errorMessage(payload) }));
        return true;
      }
      return false;
    }

    try {
      const response = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          mode,
          currentStep: currentStep ?? null,
          messages: history.map((message) => ({ role: message.role, content: message.content })),
        }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error(errorMessage(data));
      }
      if (!response.body) throw new Error("پاسخ جریانی دستیار در دسترس نیست.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let complete = false;
      try {
        while (!complete) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split(/\r?\n\r?\n/);
          buffer = events.pop() ?? "";
          for (const event of events) {
            if (receiveEvent(event)) {
              complete = true;
              break;
            }
          }
        }
        buffer += decoder.decode();
        if (!complete && buffer) complete = receiveEvent(buffer);
      } finally {
        reader.releaseLock();
      }
      if (!complete) {
        setReply((current) => ({
          ...current,
          content: current.content || "⚠️ پاسخ دستیار کامل نشد. دوباره تلاش کنید.",
        }));
      }
    } catch (error) {
      setReply(() => ({
        id: replyId,
        role: "assistant",
        content: "⚠️ " + (error instanceof Error ? error.message : "اتصال برقرار نشد. دوباره تلاش کنید."),
      }));
    } finally {
      setBusy(false);
    }
  }

  async function applyProposal(message: Msg) {
    if (!canPropose) return;
    const proposal = message.proposal;
    if (!proposal) return;
    const meta = ACTION_CATALOG[proposal.type];
    if (!meta) return;
    const endpoint = resolveActionEndpoint(meta, proposal.payload);
    if (!endpoint) {
      toast.error("شناسهٔ لازم برای اجرای این پیشنهاد در آن موجود نیست.");
      return;
    }
    setApplyingId(message.id);
    try {
      const response = await fetch(endpoint, {
        method: meta.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(proposal.payload),
      });
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        const detail = Array.isArray(data.messages)
          ? data.messages.join(" ")
          : typeof data.error === "string"
            ? data.error
            : "";
        if (message.auditId) {
          void finishAudit(message.auditId, "failed", { endpoint, method: meta.method, detail });
        }
        toast.error(`ثبت انجام نشد. ${detail}`.trim());
        return;
      }

      let auditUpdated = true;
      if (message.auditId) {
        try {
          await finishAudit(message.auditId, "applied", { endpoint, method: meta.method, status: response.status });
        } catch {
          auditUpdated = false;
        }
      }
      setMessages((current) => current.map((item) => (item.id === message.id ? { ...item, applied: true } : item)));
      toast.success(
        auditUpdated
          ? `${meta.label} انجام شد.`
          : `${meta.label} انجام شد؛ اما ثبت نتیجه در گزارش ممیزی ممکن نشد.`,
      );
      router.refresh();
      if (mode === "wizard" && meta.wizardStep) {
        setTimeout(() => router.push("/setup"), 400);
      }
    } catch {
      toast.error("خطای شبکه هنگام ثبت.");
    } finally {
      setApplyingId(null);
    }
  }

  async function finishAudit(
    id: string,
    status: "applied" | "failed" | "dismissed",
    result?: Record<string, unknown>,
  ) {
    const response = await fetch("/api/ai/action-audit", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status, result }),
    });
    if (!response.ok) throw new Error("audit_update_failed");
  }

  function dismissProposal(message: Msg) {
    if (message.auditId) {
      void finishAudit(message.auditId, "dismissed").catch(() => {
        toast.error("پیشنهاد رد شد، اما ثبت آن در گزارش ممیزی ممکن نشد.");
      });
    }
    setMessages((current) =>
      current.map((item) => (item.id === message.id ? { ...item, proposal: null } : item)),
    );
  }

  const showSuggestions =
    messages.length === 1 &&
    messages[0]?.role === "assistant" &&
    !busy &&
    !estimating &&
    !pending;

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
            <Button variant="ghost" size="icon-sm" onClick={() => setOpen(false)} aria-label="بستن">
              <XIcon />
            </Button>
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
                    <ProposalCard
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
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setInput(pending.text);
                      setPending(null);
                    }}
                    disabled={busy}
                  >
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
                <Link href="/dashboard/ai" className="underline underline-offset-2 hover:text-foreground">
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

function ProposalCard({
  proposal,
  applied,
  applying,
  onApply,
  onDismiss,
}: {
  proposal: ProposedAction;
  applied?: boolean;
  applying: boolean;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const meta = ACTION_CATALOG[proposal.type];
  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm">
      <div className="mb-1 flex items-center gap-1.5 font-semibold text-primary">
        <SparklesIcon className="size-4" />
        {proposal.title || meta?.label}
      </div>
      {proposal.summary ? <p className="mb-2 text-foreground/90">{proposal.summary}</p> : null}
      <pre
        dir="ltr"
        className="mb-2 max-h-40 overflow-auto rounded-lg bg-background/70 p-2 text-left text-[11px] text-muted-foreground"
      >
        {JSON.stringify(proposal.payload, null, 2)}
      </pre>
      {applied ? (
        <p className="flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
          <CheckIcon className="size-4" /> ثبت شد
        </p>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" onClick={onApply} disabled={applying}>
            {applying ? <Loader2Icon className="animate-spin" /> : <CheckIcon />}
            تأیید و اجرا
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss} disabled={applying}>
            رد
          </Button>
        </div>
      )}
    </div>
  );
}
