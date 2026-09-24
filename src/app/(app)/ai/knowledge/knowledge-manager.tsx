"use client";

/**
 * «دانش دستیار» — the AI Knowledge section's client (Phase I).
 *
 * A read-only view over `/api/ai/knowledge`: whether retrieval infra and the
 * embedding connection are available, how many chunks are embedded (per kind),
 * when the index was last refreshed, and a manual «به‌روزرسانی نمایه» that runs
 * the same bounded indexing tick the platform schedules (`/api/ai/rag/reindex`).
 *
 * It shows only what the assistant can *recall* from stored text; numbers are
 * never embedded (they are read live through tools), and that decision is stated
 * on the page rather than left implicit. When pgvector is absent the section
 * says so plainly — the assistant still works, it just can't recall from text.
 */

import { useCallback, useEffect, useState } from "react";
import { LibraryBigIcon, RefreshCwIcon, InfoIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useFeatureLocked } from "@/components/feature-lock";
import { api } from "@/app/dashboard/ui";
import {
  EmptyState,
  LoadingSkeleton,
  SectionCard,
  cardClass,
} from "@/app/dashboard/page-chrome";
import { cn } from "@/lib/utils";
import { toPersianDigits } from "@/lib/digits";
import { formatShortDateTime } from "@/app/dashboard/ai/format";
import type {
  AiKnowledgeReindexResult,
  AiKnowledgeStatus,
} from "@/lib/ai-knowledge-shared";

export function KnowledgeManager() {
  const locked = useFeatureLocked();
  const [status, setStatus] = useState<AiKnowledgeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reindexing, setReindexing] = useState(false);

  const load = useCallback(async () => {
    if (locked) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(false);
    const { ok, data } = await api<{ status?: AiKnowledgeStatus }>("/api/ai/knowledge");
    if (ok && data.status) {
      setStatus(data.status);
    } else {
      setError(true);
    }
    setLoading(false);
  }, [locked]);

  useEffect(() => {
    void load();
  }, [load]);

  async function reindex() {
    if (reindexing) return;
    setReindexing(true);
    const { ok, status: httpStatus, data } = await api<
      AiKnowledgeReindexResult & { error?: string }
    >("/api/ai/rag/reindex", { method: "POST" });
    setReindexing(false);
    if (!ok) {
      toast.error(
        httpStatus === 503
          ? "سرویس هوش مصنوعی هنوز آماده نشده است."
          : "به‌روزرسانی نمایه ممکن نشد.",
      );
      return;
    }
    if (!data.retrieval) {
      toast.error("زیرساخت بازیابی (pgvector) در دسترس نیست؛ چیزی نمایه نشد.");
    } else {
      toast.success(
        `نمایه به‌روزرسانی شد: ${toPersianDigits(data.embedded)} مورد نمایه، ${toPersianDigits(data.deleted)} مورد پاک‌سازی شد.`,
      );
    }
    await load();
  }

  if (loading) return <LoadingSkeleton rows={5} />;

  if (locked) {
    return (
      <EmptyState>
        دستیار هوشمند برای این کسب‌وکار فعال نیست؛ نمایهٔ دانشی برای نمایش وجود ندارد.
      </EmptyState>
    );
  }

  if (error || !status) {
    return (
      <div className="space-y-3">
        <EmptyState>خواندن وضعیت دانش ممکن نشد.</EmptyState>
        <div className="text-center">
          <Button variant="outline" onClick={() => void load()}>
            تلاش دوباره
          </Button>
        </div>
      </div>
    );
  }

  const maxCount = status.byKind.reduce((max, k) => Math.max(max, k.count), 0);

  return (
    <div className="mt-4 space-y-4">
      {/* Retrieval-unavailable banner — truthful empty state, not an error. */}
      {!status.retrievalAvailable ? (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p>
            زیرساخت بازیابی (افزونهٔ pgvector) روی این نصب در دسترس نیست؛ دستیار
            همچنان کار می‌کند، اما نمی‌تواند از متن‌های ذخیره‌شدهٔ کسب‌وکار چیزی به‌خاطر
            بیاورد.
          </p>
        </div>
      ) : null}

      {/* Headline + reindex */}
      <div className={cn(cardClass, "flex flex-wrap items-center justify-between gap-3 p-4")}>
        <div className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
            <LibraryBigIcon className="size-5" aria-hidden="true" />
          </span>
          <div>
            <p className="text-lg font-bold text-foreground">
              {toPersianDigits(status.totalChunks)} مورد نمایه‌شده
            </p>
            <p className="text-xs text-muted-foreground">
              آخرین به‌روزرسانی: {status.lastIndexedAt ? formatShortDateTime(status.lastIndexedAt) : "هنوز نمایه نشده"}
            </p>
          </div>
        </div>
        <Button
          onClick={() => void reindex()}
          disabled={reindexing || !status.retrievalAvailable || !status.aiConfigured}
          className="gap-2"
        >
          <RefreshCwIcon className="size-4" aria-hidden="true" />
          {reindexing ? "در حال به‌روزرسانی…" : "به‌روزرسانی نمایه"}
        </Button>
      </div>

      {!status.aiConfigured ? (
        <p className="text-xs text-muted-foreground">
          اتصال هوش مصنوعی هنوز توسط مدیر پلتفرم آماده نشده است؛ تا آن زمان
          به‌روزرسانی نمایه ممکن نیست.
        </p>
      ) : null}

      {/* Per-kind breakdown */}
      <SectionCard
        title="دانش بر اساس نوع"
        description="آنچه دستیار می‌تواند از هر بخش کسب‌وکار به‌خاطر بیاورد."
      >
        {status.totalChunks === 0 ? (
          <EmptyState>
            هنوز چیزی نمایه نشده است. با «به‌روزرسانی نمایه»، متن‌های کم‌تغییر
            کسب‌وکار برای بازیابی آماده می‌شوند.
          </EmptyState>
        ) : (
          <ul className="space-y-3">
            {status.byKind.map((slice) => (
              <li key={slice.kind}>
                <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
                  <span className="min-w-0">
                    <span className="font-medium text-foreground">{slice.label}</span>
                    <span className="ms-2 text-xs text-muted-foreground">{slice.hint}</span>
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {toPersianDigits(slice.count)} مورد
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="presentation">
                  <div
                    className="h-full rounded-full bg-primary/70"
                    style={{
                      width:
                        maxCount > 0 && slice.count > 0
                          ? `${Math.max(3, (slice.count / maxCount) * 100)}%`
                          : "0%",
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <p className="px-1 text-[11px] leading-5 text-muted-foreground">
        نکته: عددهای کسب‌وکار — سفارش‌ها، موجودی، پرداخت‌ها و اسناد حسابداری —
        هرگز در نمایه ذخیره نمی‌شوند و همیشه زنده و لحظه‌ای از طریق ابزارها خوانده
        می‌شوند، تا پاسخ‌ها هیچ‌گاه بر پایهٔ عدد کهنه نباشند.
      </p>
    </div>
  );
}
