"use client";

/**
 * The operational queue: outbound outbox jobs (stock/price pushes, product/
 * order operations, export requests) plus inbound events that failed to
 * apply. One screen for «چرا سفارش/مشتری/محصول نیامد؟» — the same rows the
 * audit log records, in the order they happened.
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { RefreshCwIcon, ArrowUpRightIcon, ArrowDownLeftIcon } from "lucide-react";
import { api } from "@/app/dashboard/ui";
import { cardClass, EmptyState, SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import { ConnectionPicker, type ConnectionLite } from "./connection-lite";

interface QueueRow {
  id: string;
  direction: "out" | "in";
  kind: string;
  status: string;
  remoteId: string;
  error: string | null;
  attempts: number;
  createdAt: string;
}

const KIND_LABELS: Record<string, string> = {
  stock: "به‌روزرسانی موجودی",
  price: "به‌روزرسانی قیمت",
  product_update: "ویرایش محصول",
  order_status: "تغییر وضعیت سفارش",
  refund_create: "برگشت وجه",
  catalogue_export: "درخواست خروجی کاتالوگ",
  customer_export: "درخواست خروجی مشتریان",
  orders_export: "درخواست خروجی سفارش‌ها",
  content_export: "درخواست خروجی محتوا",
  post_upsert: "ذخیرهٔ نوشته/برگه",
  media_create: "افزودن رسانه",
  "order.created": "رویداد: سفارش تازه",
  "order.updated": "رویداد: به‌روزرسانی سفارش",
  "refund.created": "رویداد: برگشت وجه",
  "product.updated": "رویداد: به‌روزرسانی محصول",
  "customer.updated": "رویداد: به‌روزرسانی مشتری",
  "content.updated": "رویداد: به‌روزرسانی محتوا",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "در انتظار",
  processing: "در حال پردازش",
  failed: "ناموفق",
  dead: "متوقف‌شده",
  sent: "ارسال‌شده",
  processed: "ثبت‌شده",
  duplicate: "تکراری",
};

export function WpQueueSection() {
  const [connections, setConnections] = useState<ConnectionLite[] | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    api<{ connections: ConnectionLite[] }>("/api/integrations/connections?provider=woocommerce").then((res) => {
      if (res.ok) {
        setConnections(res.data.connections);
        setSelectedId(res.data.connections[0]?.id ?? "");
      } else setConnections([]);
    });
  }, []);

  const load = useCallback((connectionId: string, keepRows = false) => {
    // A manual «تازه‌سازی» keeps the rows it already has: collapsing the
    // list to a skeleton on every refresh made the queue look empty for a
    // beat, which is exactly the wrong signal on a screen about failures.
    if (!keepRows) setRows(null);
    setRefreshing(true);
    api<{ rows: QueueRow[] }>(`/api/integrations/wp-manager/queue?connectionId=${connectionId}`).then(
      (res) => {
        if (res.ok) setRows(res.data.rows);
        else setRows([]);
        setRefreshing(false);
      },
    );
  }, []);

  useEffect(() => {
    if (selectedId) load(selectedId);
  }, [selectedId, load]);

  if (connections === null) return <SectionCardSkeleton rows={6} />;
  if (connections.length === 0) return <EmptyState>فروشگاهی متصل نیست.</EmptyState>;

  return (
    <div className="space-y-4">
      <div className={`${cardClass} flex flex-wrap items-center gap-3 p-4`}>
        <ConnectionPicker embedded connections={connections} value={selectedId} onChange={setSelectedId} />
        <Button
          variant="outline"
          size="sm"
          onClick={() => load(selectedId, true)}
          className="ms-auto"
          disabled={refreshing}
        >
          <RefreshCwIcon className="size-4" />
          {refreshing ? "در حال تازه‌سازی…" : "تازه‌سازی"}
        </Button>
      </div>

      <section className={`${cardClass} overflow-hidden`}>
        <div className="border-b border-border/80 px-4 py-4 sm:px-5">
          <h2 className="font-semibold text-foreground">صف همگام‌سازی و رویدادها</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            کارهای خروجی در انتظار ارسال به فروشگاه و رویدادهای ورودی ناموفق. صف با افزونه در اجرای بعدی آن
            خالی می‌شود؛ موارد «متوقف‌شده» پس از چند تلاش ناموفق، برای بررسی دستی باقی مانده‌اند.
          </p>
        </div>
        {rows === null ? (
          <SectionCardSkeleton rows={4} />
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground sm:px-5">
            صف خالی است — کار در انتظار یا رویداد ناموفقی وجود ندارد.
          </div>
        ) : (
          <ul className="divide-y divide-border/80">
            {rows.map((row) => (
              <li key={`${row.direction}-${row.id}`} className="flex flex-wrap items-start gap-3 px-4 py-3 sm:px-5">
                <span
                  className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full ${
                    row.direction === "out"
                      ? "bg-teal-50 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300"
                      : "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"
                  }`}
                >
                  {row.direction === "out" ? <ArrowUpRightIcon className="size-4" /> : <ArrowDownLeftIcon className="size-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">
                    {KIND_LABELS[row.kind] ?? row.kind}
                    <span className="ms-2 text-xs font-normal text-muted-foreground">
                      شناسه: {toPersianDigits(row.remoteId)}
                    </span>
                  </p>
                  {row.error ? (
                    <p className="mt-1 break-words rounded-lg bg-red-50 px-2 py-1 text-[11px] text-red-700 dark:bg-red-500/10 dark:text-red-300">
                      {row.error}
                    </p>
                  ) : null}
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {formatJalali(row.createdAt, { withTime: true })}
                    {row.attempts > 0 ? ` • ${toPersianDigits(row.attempts)} تلاش` : ""}
                  </p>
                </div>
                <StatusBadge
                  tone={
                    row.status === "dead" || row.status === "failed"
                      ? "danger"
                      : row.status === "processing"
                        ? "active"
                        : "neutral"
                  }
                >
                  {STATUS_LABELS[row.status] ?? row.status}
                </StatusBadge>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
