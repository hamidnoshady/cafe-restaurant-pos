"use client";

/**
 * Shared chat core (Wave 2, issue #142) behind both the dashboard/ai hub and
 * the floating launcher (`ai-assistant.tsx`): streaming, cost estimate,
 * propose→confirm and now conversation persistence (Wave 1, issue #141) all
 * live here once so the two surfaces never drift.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ACTION_CATALOG, resolveActionEndpoint, type ProposedAction } from "@/lib/ai";

export type AssistantMode = "wizard" | "dashboard" | "floor";

export interface AiChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  proposal?: ProposedAction | null;
  auditId?: string | null;
  applied?: boolean;
}

export interface TurnEstimate {
  estimatedCostRial: number;
  maximumReservationRial: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  assumedToolRounds: number;
  hasTools: boolean;
}

export interface PendingTurn {
  text: string;
  estimate: TurnEstimate;
}

export const uid = (): string => Math.random().toString(36).slice(2);

export const CHAT_ERROR: Record<string, string> = {
  ai_credit_required: "اعتبار هوش مصنوعی برای یک پاسخ جدید کافی نیست. از صفحهٔ اعتبار درخواست شارژ ثبت کنید.",
  ai_unavailable: "سرویس هوش مصنوعی هنوز توسط مدیر پلتفرم آماده نشده است.",
  feature_disabled: "دستیار هوشمند برای این کسب‌وکار فعال نیست.",
  ai_auth: "اتصال سراسری سرویس هوش مصنوعی نیاز به بررسی مدیر پلتفرم دارد.",
  ai_timeout: "پاسخ سرویس دیر رسید. دوباره تلاش کنید.",
  ai_network: "اتصال به سرویس هوش مصنوعی برقرار نشد.",
  ai_provider: "سرویس هوش مصنوعی خطا داد. بعداً تلاش کنید.",
  empty_messages: "پیامی برای ارسال نیست.",
};

export const SUGGESTED_PROMPTS: Record<AssistantMode, string[]> = {
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

export function greeting(mode: AssistantMode): string {
  if (mode === "wizard") {
    return "سلام! من دستیار راه‌اندازی هستم. بگویید کافه یا رستوران‌تان چه ویژگی‌هایی دارد تا با هم فیلدهای هر مرحله را کامل کنیم. هر تغییری قبل از ثبت، تأیید شما را لازم دارد.";
  }
  if (mode === "floor") {
    return "سلام! می‌توانم دربارهٔ منوی شعبه، مواد اولیهٔ ثبت‌شده و پیش‌نمایش تقسیم برابر صورت‌حساب کمک کنم. هیچ تغییری ثبت نمی‌کنم؛ برای موارد حساسیت غذایی، دادهٔ ثبت‌نشده را حدس نمی‌زنم.";
  }
  return "سلام! می‌توانم گزارش‌های فروش، منو، موجودی و حسابداری را نشان دهم، وضعیت راه‌اندازی را بررسی کنم و کارهای مجاز را با تأیید شما انجام دهم. چه کمکی از من برمی‌آید؟";
}

export function errorMessage(data: Record<string, unknown>): string {
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

interface ConversationMessagePayload {
  id: string;
  role: "user" | "assistant";
  content: string;
  proposal: ProposedAction | null;
}

export interface UseAiChatOptions {
  mode: AssistantMode;
  currentStep?: string | null;
  /** Called whenever the active conversation id changes (new turn, load, reset). */
  onConversationIdChange?: (id: string | null) => void;
}

export function useAiChat({ mode, currentStep, onConversationIdChange }: UseAiChatOptions) {
  const router = useRouter();
  const canPropose = mode === "wizard" || mode === "dashboard";
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [estimating, setEstimating] = useState(false);
  const [pending, setPending] = useState<PendingTurn | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [loadingConversation, setLoadingConversation] = useState(false);

  function setConversation(id: string | null) {
    setConversationId(id);
    onConversationIdChange?.(id);
  }

  function ensureGreeting() {
    setMessages((current) => (current.length === 0 ? [{ id: uid(), role: "assistant", content: greeting(mode) }] : current));
  }

  function startNewConversation() {
    setConversation(null);
    setPending(null);
    setInput("");
    setMessages([{ id: uid(), role: "assistant", content: greeting(mode) }]);
  }

  async function loadConversation(id: string) {
    setLoadingConversation(true);
    try {
      const response = await fetch(`/api/ai/conversations/${id}`);
      const data = (await response.json().catch(() => ({}))) as {
        messages?: ConversationMessagePayload[];
        error?: string;
      };
      if (!response.ok || !data.messages) throw new Error(data.error ?? "not_found");
      setMessages(
        data.messages.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          proposal: canPropose ? message.proposal : null,
        })),
      );
      setConversation(id);
      setPending(null);
    } catch {
      toast.error("بازکردن این مکالمه ممکن نشد.");
    } finally {
      setLoadingConversation(false);
    }
  }

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

  function cancelPending() {
    if (!pending) return;
    setInput(pending.text);
    setPending(null);
  }

  async function startStream(text: string) {
    if (busy) return;
    const userMsg: AiChatMessage = { id: uid(), role: "user", content: text };
    const replyId = uid();
    const history = [...messages, userMsg];
    setMessages([...history, { id: replyId, role: "assistant", content: "" }]);
    setPending(null);
    setBusy(true);

    function setReply(update: (current: AiChatMessage) => AiChatMessage) {
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
        if (typeof payload.conversationId === "string") setConversation(payload.conversationId);
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
          conversationId,
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

  async function applyProposal(message: AiChatMessage) {
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

  function dismissProposal(message: AiChatMessage) {
    if (message.auditId) {
      void finishAudit(message.auditId, "dismissed").catch(() => {
        toast.error("پیشنهاد رد شد، اما ثبت آن در گزارش ممیزی ممکن نشد.");
      });
    }
    setMessages((current) =>
      current.map((item) => (item.id === message.id ? { ...item, proposal: null } : item)),
    );
  }

  return {
    canPropose,
    messages,
    setMessages,
    input,
    setInput,
    busy,
    estimating,
    pending,
    applyingId,
    conversationId,
    loadingConversation,
    ensureGreeting,
    startNewConversation,
    loadConversation,
    prepareSend,
    cancelPending,
    startStream,
    applyProposal,
    dismissProposal,
  };
}
