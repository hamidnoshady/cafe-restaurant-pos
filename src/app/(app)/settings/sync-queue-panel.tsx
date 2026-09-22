"use client";

/**
 * Sync Queue System panel (Section 5 of the offline-first audit): surfaces
 * the client's local action queue (src/lib/offline-db.ts /
 * src/app/dashboard/offline-queue.tsx) with its Pending/Syncing/Completed/
 * Failed/Conflict lifecycle, instead of the previous silent "it's either
 * still queued or it's gone" model. Lives on the Devices settings tab — this
 * is this browser/terminal's own local queue, not a tenant-wide setting.
 */
import { useMemo } from "react";
import { AlertTriangleIcon, ClockIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { SYNC_QUEUE_STATUS_LABELS, type SyncQueueStatus } from "@/lib/sync-queue";
import { discardQueueEntry, retryQueueEntry, useOfflineQueue, type PendingAction } from "@/app/dashboard/offline-queue";
import { SectionCard, StatusBadge, EmptyState } from "@/app/dashboard/page-chrome";
import { Button } from "@/components/ui/button";

function statusTone(status: SyncQueueStatus): "active" | "positive" | "neutral" | "danger" {
  switch (status) {
    case "completed":
      return "positive";
    case "failed":
    case "conflict":
      return "danger";
    case "syncing":
      return "active";
    default:
      return "neutral";
  }
}

function actionTypeLabel(type: PendingAction["type"]): string {
  switch (type) {
    case "order.create":
      return "ثبت سفارش";
    case "order.add_items":
      return "افزودن قلم به سفارش";
    case "order_item.status":
      return "به‌روزرسانی وضعیت قلم";
    case "inventory.waste.recorded":
      return "ثبت ضایعات";
    default:
      return type;
  }
}

function formatQueuedAt(createdAt: number): string {
  return toPersianDigits(formatJalali(new Date(createdAt).toISOString(), { withMonthName: true, withTime: true }));
}

/** Everything the entry needs to explain itself: what it is, where it targets, and why it's stuck. */
function entrySubtitle(entry: PendingAction): string {
  const parts = [entry.table, entry.recordId ?? "—", `تلاش ${toPersianDigits(String(entry.retryCount))}`];
  if (entry.lastError) parts.push(`آخرین خطا: ${entry.lastError}`);
  return parts.join(" · ");
}

export function SyncQueuePanel() {
  const { entries } = useOfflineQueue();

  const needsAttention = useMemo(
    () => entries.filter((e) => e.status === "failed" || e.status === "conflict"),
    [entries],
  );
  const inFlight = useMemo(
    () => entries.filter((e) => e.status === "pending" || e.status === "syncing"),
    [entries],
  );

  if (entries.length === 0) {
    return (
      <SectionCard
        title="صف همگام‌سازی محلی"
        description="اقدام‌هایی که هنگام قطع اتصال به سرور محلی ذخیره و پس از اتصال مجدد ارسال می‌شوند."
      >
        <div className="p-4 sm:p-5">
          <EmptyState>صف این دستگاه خالی است؛ همهٔ اقدام‌ها با سرور محلی همگام‌اند.</EmptyState>
        </div>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="صف همگام‌سازی محلی"
      description="اقدام‌هایی که هنگام قطع اتصال به سرور محلی روی همین دستگاه ذخیره شده‌اند."
      actions={
        needsAttention.length > 0 ? (
          <StatusBadge tone="danger">{toPersianDigits(String(needsAttention.length))} نیازمند بررسی</StatusBadge>
        ) : (
          <StatusBadge tone="active">{toPersianDigits(String(inFlight.length))} در حال ارسال</StatusBadge>
        )
      }
      flush
    >
      <ul className="divide-y divide-border/80">
        {entries.map((entry) => (
          <li key={entry.id} className="flex flex-col gap-3 px-4 py-4 sm:px-5 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 break-words font-semibold text-foreground">{entry.description}</p>
                <StatusBadge tone={statusTone(entry.status)} dot>
                  {SYNC_QUEUE_STATUS_LABELS[entry.status]}
                </StatusBadge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {actionTypeLabel(entry.type)} · {entrySubtitle(entry)}
              </p>
              <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                <ClockIcon aria-hidden="true" className="size-3.5 shrink-0" />
                {formatQueuedAt(entry.createdAt)}
              </p>
            </div>
            {(entry.status === "failed" || entry.status === "conflict") ? (
              <div className="flex w-full flex-wrap gap-2 md:w-auto md:justify-end">
                {entry.status === "conflict" ? (
                  <span className="flex items-center gap-1 text-xs text-destructive">
                    <AlertTriangleIcon aria-hidden="true" className="size-3.5 shrink-0" />
                    این تغییر با یک عملیات دیگر تداخل دارد
                  </span>
                ) : null}
                <Button type="button" variant="outline" size="sm" onClick={() => void retryQueueEntry(entry.id)}>
                  <RefreshCwIcon aria-hidden="true" />
                  تلاش دوباره
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => void discardQueueEntry(entry.id)}
                >
                  <Trash2Icon aria-hidden="true" />
                  حذف از صف
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
