"use client";

/**
 * Floating AI assistant: a bottom-left launcher that opens a chat panel. Works in
 * two modes — "wizard" (helps fill the setup steps) and "dashboard" (reports +
 * confirmed jobs). Every mutation the agent proposes is shown as a confirm card;
 * nothing is written until the user presses "Apply", which POSTs the proposed
 * payload to the mapped, already role-guarded endpoint.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { BotIcon, CheckIcon, Loader2Icon, SendIcon, SparklesIcon, XIcon } from "lucide-react";
import { ACTION_CATALOG, type ProposedAction } from "@/lib/ai";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Msg {
  id: string;
  role: "user" | "assistant";
  content: string;
  proposal?: ProposedAction | null;
  applied?: boolean;
}

interface Props {
  mode: "wizard" | "dashboard";
  currentStep?: string | null;
}

const uid = () => Math.random().toString(36).slice(2);

const CHAT_ERROR: Record<string, string> = {
  ai_disabled: "دستیار هوشمند هنوز فعال نشده است. از تنظیمات، سرویس و کلید را وارد کنید.",
  ai_auth: "کلید سرویس هوش مصنوعی نامعتبر است. آن را در تنظیمات بررسی کنید.",
  ai_timeout: "پاسخ سرویس دیر رسید. دوباره تلاش کنید.",
  ai_network: "اتصال به سرویس هوش مصنوعی برقرار نشد.",
  ai_provider: "سرویس هوش مصنوعی خطا داد. بعداً تلاش کنید.",
  empty_messages: "پیامی برای ارسال نیست.",
};

function greeting(mode: "wizard" | "dashboard"): string {
  return mode === "wizard"
    ? "سلام! من دستیار راه‌اندازی هستم. بگویید کافه یا رستوران‌تان چه ویژگی‌هایی دارد تا با هم فیلدهای هر مرحله را کامل کنیم. هر تغییری قبل از ثبت، تأیید شما را لازم دارد."
    : "سلام! می‌توانم گزارش‌های فروش، منو، موجودی و حسابداری را نشان دهم، وضعیت راه‌اندازی را بررسی کنم و کارهای مجاز را با تأیید شما انجام دهم. چه کمکی از من برمی‌آید؟";
}

export function AiAssistant({ mode, currentStep }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && messages.length === 0) {
      setMessages([{ id: uid(), role: "assistant", content: greeting(mode) }]);
    }
  }, [open, mode, messages.length]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    const userMsg: Msg = { id: uid(), role: "user", content: text };
    const history = [...messages, userMsg];
    setMessages(history);
    setInput("");
    setBusy(true);

    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          currentStep: currentStep ?? null,
          messages: history.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = CHAT_ERROR[data.error as string] ?? data.message ?? "خطا در ارتباط با دستیار.";
        setMessages((prev) => [...prev, { id: uid(), role: "assistant", content: `⚠️ ${msg}` }]);
        return;
      }
      setMessages((prev) => [
        ...prev,
        { id: uid(), role: "assistant", content: data.content ?? "", proposal: data.proposedAction ?? null },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { id: uid(), role: "assistant", content: "⚠️ اتصال برقرار نشد. دوباره تلاش کنید." },
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function applyProposal(msg: Msg) {
    const proposal = msg.proposal;
    if (!proposal) return;
    const meta = ACTION_CATALOG[proposal.type];
    if (!meta) return;
    setApplyingId(msg.id);
    try {
      const res = await fetch(meta.endpoint, {
        method: meta.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(proposal.payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = Array.isArray(data.messages) ? data.messages.join(" ") : (data.error ?? "");
        toast.error(`ثبت انجام نشد. ${detail}`.trim());
        return;
      }
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, applied: true } : m)));
      toast.success(`${meta.label} انجام شد.`);
      router.refresh();
      // In the wizard, jump to the next incomplete step so progress keeps flowing.
      if (mode === "wizard" && meta.wizardStep) {
        setTimeout(() => router.push("/setup"), 400);
      }
    } catch {
      toast.error("خطای شبکه هنگام ثبت.");
    } finally {
      setApplyingId(null);
    }
  }

  function dismissProposal(id: string) {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, proposal: null } : m)));
  }

  return (
    <>
      {/* Launcher — bottom-left (physical left, per request) */}
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
        <div className="fixed bottom-5 left-5 z-50 flex h-[min(70vh,560px)] w-[min(92vw,380px)] flex-col overflow-hidden rounded-2xl border bg-card shadow-2xl ring-1 ring-foreground/10">
          <header className="flex items-center justify-between border-b bg-primary/5 px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-full bg-primary/15 text-primary">
                <BotIcon className="size-4.5" />
              </span>
              <div>
                <p className="text-sm font-bold leading-tight">دستیار هوشمند</p>
                <p className="text-[11px] text-muted-foreground">
                  {mode === "wizard" ? "کمک به راه‌اندازی" : "گزارش‌ها و کارها"}
                </p>
              </div>
            </div>
            <Button variant="ghost" size="icon-sm" onClick={() => setOpen(false)} aria-label="بستن">
              <XIcon />
            </Button>
          </header>

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
            {messages.map((m) => (
              <div key={m.id} className={cn("flex", m.role === "user" ? "justify-start" : "justify-end")}>
                <div className="max-w-[85%] space-y-2">
                  <div
                    className={cn(
                      "whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm leading-relaxed",
                      m.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-foreground",
                    )}
                  >
                    {m.content}
                  </div>
                  {m.proposal && (
                    <ProposalCard
                      proposal={m.proposal}
                      applied={m.applied}
                      applying={applyingId === m.id}
                      onApply={() => applyProposal(m)}
                      onDismiss={() => dismissProposal(m.id)}
                    />
                  )}
                </div>
              </div>
            ))}
            {busy && (
              <div className="flex justify-end">
                <div className="flex items-center gap-2 rounded-2xl bg-muted px-3 py-2 text-sm text-muted-foreground">
                  <Loader2Icon className="size-4 animate-spin" /> در حال فکر کردن…
                </div>
              </div>
            )}
          </div>

          <div className="border-t p-2">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                rows={1}
                placeholder="پیام خود را بنویسید…"
                className="max-h-28 min-h-9 flex-1 resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
              />
              <Button size="icon" onClick={() => void send()} disabled={busy || !input.trim()} aria-label="ارسال">
                <SendIcon className="rtl:-scale-x-100" />
              </Button>
            </div>
            <p className="mt-1 px-1 text-[10px] text-muted-foreground">
              دستیار ممکن است اشتباه کند؛ تغییرها فقط با تأیید شما ثبت می‌شوند.{" "}
              <Link href="/dashboard/ai" className="underline underline-offset-2 hover:text-foreground">
                تنظیمات
              </Link>
            </p>
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
      {proposal.summary && <p className="mb-2 text-foreground/90">{proposal.summary}</p>}
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
