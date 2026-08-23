"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckIcon, Loader2Icon, RotateCcwIcon, WandSparklesIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useFeatureLocked } from "@/components/feature-lock";
import { ACTION_CATALOG, type ActionType } from "@/lib/ai";
import { AUTOPILOT_CATEGORY_LABELS, type AutopilotCategory } from "@/lib/ai-autopilot";
import { applyProposalRequest } from "@/components/ai/apply-proposal";

interface Entry {
  id: string;
  actionType: string;
  actionTitle: string;
  actionSummary: string;
  category: AutopilotCategory | null;
  status: "proposed" | "applied" | "failed" | "dismissed" | "reverted";
  deferredReason: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  revertedAt: string | null;
}

const STATUS_LABEL: Record<Entry["status"], string> = {
  proposed: "در انتظار تأیید شما",
  applied: "انجام شد",
  failed: "ناموفق",
  dismissed: "رد شد",
  reverted: "برگردانده شد",
};

const STATUS_CLASS: Record<Entry["status"], string> = {
  proposed: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  applied: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  failed: "bg-destructive/10 text-destructive",
  dismissed: "bg-muted text-muted-foreground",
  reverted: "bg-muted text-muted-foreground",
};

const DEFERRED_REASON: Record<string, string> = {
  action_not_eligible: "این اقدام همیشه به تأیید شما نیاز دارد.",
  category_disabled: "اجرای خودکار این دسته خاموش بود.",
  daily_limit_reached: "سقف تعداد اجرای امروز تکمیل شده بود.",
  too_many_items: "تعداد اقلام بیش از حد مجاز بود.",
  invalid_payload: "اطلاعات پیشنهاد کامل نبود.",
  missing_context: "برای سنجش در برابر سقف، اطلاعات کافی نبود.",
  price_change_too_large: "درصد تغییر قیمت بیش از سقف شما بود.",
  amount_over_cap: "مبلغ بیش از سقف تعیین‌شدهٔ شما بود.",
  unbalanced_entry: "بدهکار و بستانکار سند برابر نبود.",
  payload_touches_other_fields: "پیشنهاد فیلدهایی بیرون از یادداشت را تغییر می‌داد.",
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function AiAutopilotActivity() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const locked = useFeatureLocked();

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/ai/autopilot/activity");
      const body = (await response.json().catch(() => ({}))) as { entries?: Entry[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "خواندن سابقهٔ اجرای خودکار ممکن نشد.");
      setEntries(body.entries ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "خواندن سابقهٔ اجرای خودکار ممکن نشد.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (locked) {
      setLoading(false);
      return;
    }
    void (async () => {
      await load();
      // Opening this list is what marks the launcher's badge read. The same
      // custom-event channel the assistant already uses for `ai:prefill`
      // clears the badge without a refetch.
      await fetch("/api/ai/autopilot/activity", { method: "POST" }).catch(() => {});
      window.dispatchEvent(new CustomEvent("ai:autopilot-seen"));
    })();
  }, [locked, load]);

  async function revert(entry: Entry) {
    if (busyId) return;
    setBusyId(entry.id);
    try {
      const response = await fetch("/api/ai/autopilot/revert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auditId: entry.id }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "بازگرداندن ممکن نشد.");
      toast.success("به وضعیت قبلی برگردانده شد.");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "بازگرداندن ممکن نشد.");
    } finally {
      setBusyId(null);
    }
  }

  /** A deferred proposal takes exactly the manual path a chat proposal takes. */
  async function applyDeferred(entry: Entry) {
    if (busyId) return;
    setBusyId(entry.id);
    try {
      const outcome = await applyProposalRequest({
        type: entry.actionType as ActionType,
        title: entry.actionTitle,
        summary: entry.actionSummary,
        payload: entry.payload,
      });
      if (!outcome.ok) {
        toast.error(`ثبت انجام نشد. ${outcome.detail}`.trim());
        return;
      }
      await fetch("/api/ai/action-audit", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: entry.id, status: "applied", result: { endpoint: outcome.endpoint } }),
      }).catch(() => {});
      toast.success(`${ACTION_CATALOG[entry.actionType as ActionType]?.label ?? "اقدام"} انجام شد.`);
      await load();
    } catch {
      toast.error("خطای شبکه هنگام ثبت.");
    } finally {
      setBusyId(null);
    }
  }

  async function dismiss(entry: Entry) {
    if (busyId) return;
    setBusyId(entry.id);
    try {
      await fetch("/api/ai/action-audit", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: entry.id, status: "dismissed" }),
      });
      await load();
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return (
      <section className="rounded-2xl border bg-card p-5 text-sm text-muted-foreground">
        <Loader2Icon className="me-2 inline size-4 animate-spin" /> در حال خواندن سابقهٔ اجرای خودکار…
      </section>
    );
  }

  return (
    <section className="rounded-2xl border bg-card p-5">
      <h2 className="flex items-center gap-2 font-semibold">
        <WandSparklesIcon className="size-5 text-primary" /> کارهای انجام‌شدهٔ خودکار
      </h2>
      {entries.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">هنوز هیچ اقدام خودکاری ثبت نشده است.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {entries.map((entry) => {
            const meta = ACTION_CATALOG[entry.actionType as ActionType];
            const canRevert = entry.status === "applied" && Boolean(meta?.revertible);
            const busy = busyId === entry.id;
            return (
              <li key={entry.id} className="rounded-xl border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{entry.actionTitle || meta?.label}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] ${STATUS_CLASS[entry.status]}`}>
                    {STATUS_LABEL[entry.status]}
                  </span>
                  {entry.category ? (
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
                      {AUTOPILOT_CATEGORY_LABELS[entry.category]}
                    </span>
                  ) : null}
                  <span className="ms-auto text-[11px] text-muted-foreground">{formatDate(entry.createdAt)}</span>
                </div>
                {entry.actionSummary ? (
                  <p className="mt-1 text-xs leading-6 text-muted-foreground">{entry.actionSummary}</p>
                ) : null}
                {entry.status === "proposed" && entry.deferredReason ? (
                  <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                    {DEFERRED_REASON[entry.deferredReason] ?? "برای تأیید شما نگه داشته شد."}
                  </p>
                ) : null}

                {entry.status === "proposed" ? (
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" disabled={busy} onClick={() => void applyDeferred(entry)}>
                      {busy ? <Loader2Icon className="animate-spin" /> : <CheckIcon />} تأیید و اجرا
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void dismiss(entry)}>
                      رد
                    </Button>
                  </div>
                ) : null}

                {canRevert ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    disabled={busy}
                    onClick={() => void revert(entry)}
                  >
                    {busy ? <Loader2Icon className="animate-spin" /> : <RotateCcwIcon />} بازگرداندن
                  </Button>
                ) : null}
                {entry.status === "applied" && !meta?.revertible ? (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    این اقدام بازگردانی یک‌مرحله‌ای ندارد؛ برای اصلاح از صفحهٔ مربوطه اقدام کنید.
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
