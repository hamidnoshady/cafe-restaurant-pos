"use client";

import { useEffect, useState } from "react";
import { ClipboardCheckIcon, Loader2Icon } from "lucide-react";
import { useFeatureLocked } from "@/components/feature-lock";
import { SectionCard } from "../page-chrome";

type AuditStatus = "proposed" | "applied" | "failed" | "dismissed" | "reverted";

interface AuditEntry {
  id: string;
  actorUserId: string;
  actorName: string;
  promptExcerpt: string;
  actionType: string;
  actionTitle: string;
  actionSummary: string;
  status: AuditStatus;
  source?: "manual" | "autopilot";
  createdAt: string;
  appliedAt: string | null;
}

const STATUS_LABEL: Record<AuditStatus, string> = {
  proposed: "در انتظار تصمیم",
  applied: "اجرا شد",
  failed: "ناموفق بود",
  dismissed: "رد شد",
  reverted: "برگردانده شد",
};

const STATUS_CLASS: Record<AuditStatus, string> = {
  proposed: "bg-amber-500/10 text-amber-800 dark:text-amber-200",
  applied: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  failed: "bg-destructive/10 text-destructive",
  dismissed: "bg-muted text-muted-foreground",
  reverted: "bg-muted text-muted-foreground",
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

/** Durable, manager-visible history of the confirm-before-apply action path. */
export function AiActionAudit() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState("");
  const locked = useFeatureLocked();

  useEffect(() => {
    let cancelled = false;
    // In a locked preview the route would answer `feature_disabled`; show the
    // panel's genuine empty state instead of an error the reader cannot act on.
    if (locked) {
      setEntries([]);
      return;
    }
    fetch("/api/ai/action-audit")
      .then(async (response) => {
        const data = (await response.json().catch(() => ({}))) as { entries?: AuditEntry[]; error?: string };
        if (!response.ok) throw new Error(data.error ?? "خواندن گزارش ممیزی ممکن نشد.");
        return data.entries ?? [];
      })
      .then((items) => {
        if (!cancelled) setEntries(items);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "خواندن گزارش ممیزی ممکن نشد.");
      });
    return () => {
      cancelled = true;
    };
  }, [locked]);

  return (
    <SectionCard
      title={
        <span className="flex items-center gap-2">
          <ClipboardCheckIcon className="size-5 text-primary" aria-hidden="true" /> گزارش ممیزی پیشنهادهای دستیار
        </span>
      }
      description="درخواست، پیشنهاد و نتیجهٔ هر اقدام تأییدشده یا ردشده در همین کسب‌وکار ثبت می‌شود."
    >
      {entries === null && !error ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" /> در حال خواندن گزارش ممیزی…
        </p>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {entries?.length === 0 ? (
        <p className="text-sm text-muted-foreground">هنوز پیشنهادی از دستیار ثبت نشده است.</p>
      ) : null}
      {entries?.length ? (
        <ol className="divide-y divide-stone-200/80">
          {entries.map((entry) => (
            <li key={entry.id} className="py-3 first:pt-0">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="font-medium">{entry.actionTitle || entry.actionType}</p>
                  {entry.actionSummary ? (
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">{entry.actionSummary}</p>
                  ) : null}
                  {entry.promptExcerpt ? (
                    <p className="mt-1 truncate text-xs text-muted-foreground" title={entry.promptExcerpt}>
                      درخواست: {entry.promptExcerpt}
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {entry.actorName || "کاربر"} · {formatDate(entry.createdAt)}
                  </p>
                </div>
                {entry.source === "autopilot" ? (
                  <span className="w-fit shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                    خودکار
                  </span>
                ) : null}
                <span className={"w-fit shrink-0 rounded-full px-2 py-0.5 text-xs font-medium " + STATUS_CLASS[entry.status]}>
                  {STATUS_LABEL[entry.status]}
                </span>
              </div>
            </li>
          ))}
        </ol>
      ) : null}
    </SectionCard>
  );
}
