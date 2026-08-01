"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Card, inputClass } from "../ui";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
}

const uid = () => Math.random().toString(36).slice(2);

const INITIAL_MESSAGE: Message = {
  id: "platform-support-greeting",
  role: "assistant",
  content:
    "سلام! می‌توانم وضعیت نسخهٔ نصب‌های متصل و سلامت پشتیبان‌گیری را بررسی کنم. به داده‌های عملیاتی کسب‌وکارها دسترسی ندارم و هیچ تغییری ثبت نمی‌کنم.",
};

export function PlatformSupportAssistant() {
  const [messages, setMessages] = useState<Message[]>([INITIAL_MESSAGE]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  async function send() {
    const content = input.trim();
    if (!content || busy) return;
    const userMessage: Message = { id: uid(), role: "user", content };
    const history = [...messages, userMessage];
    setMessages(history);
    setInput("");
    setBusy(true);

    try {
      const response = await fetch("/api/platform/ai/support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history.map(({ role, content: messageContent }) => ({ role, content: messageContent })),
        }),
      });
      const data = await response.json().catch(() => ({}));
      const reply =
        response.ok
          ? data.content ?? "پاسخی از دستیار دریافت نشد."
          : data.message ?? "دریافت پاسخ پشتیبانی ممکن نشد.";
      setMessages((current) => [...current, { id: uid(), role: "assistant", content: reply }]);
    } catch {
      setMessages((current) => [
        ...current,
        { id: uid(), role: "assistant", content: "ارتباط با دستیار پشتیبانی برقرار نشد." },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="دستیار پشتیبانی سکو">
      <p className="mb-3 text-sm text-white/55">
        فقط سلامت سکو: نسخهٔ نصب‌های متصل و پشتیبان‌گیری. این گفتگو نه به دادهٔ مشتریان دسترسی دارد و نه تغییری اعمال می‌کند.
      </p>
      <div
        ref={scrollRef}
        className="max-h-72 space-y-2 overflow-y-auto rounded-lg border border-white/10 bg-slate-950/40 p-3"
        aria-live="polite"
      >
        {messages.map((message) => (
          <div
            key={message.id}
            className={
              message.role === "user"
                ? "mr-auto max-w-[88%] rounded-lg bg-sky-500/20 px-3 py-2 text-sm text-sky-100"
                : "ml-auto max-w-[88%] whitespace-pre-wrap rounded-lg bg-white/8 px-3 py-2 text-sm leading-6 text-white/80"
            }
          >
            {message.content}
          </div>
        ))}
        {busy ? <p className="text-xs text-white/40">در حال بررسی…</p> : null}
      </div>
      <form
        className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          className={`${inputClass} h-20 resize-y py-2 sm:h-10 sm:resize-none`}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="مثلاً: کدام کسب‌وکارها نسخهٔ قدیمی دارند؟"
          disabled={busy}
        />
        <Button type="submit" disabled={busy || !input.trim()} className="shrink-0">
          {busy ? "در حال بررسی…" : "ارسال"}
        </Button>
      </form>
    </Card>
  );
}
