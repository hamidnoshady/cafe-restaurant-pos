"use client";

import { SectionCardSkeleton } from "@/app/dashboard/page-chrome";

/**
 * The consent register (Phase 36).
 *
 * Two things, on one page, because they answer the same question from opposite
 * ends: **coverage** ("how much of our customer base can we actually contact")
 * and the **audit trail** ("when did this specific permission change, and why").
 *
 * The trail is append-only — there is no edit and no delete path anywhere in
 * the service — because a record you can rewrite is not evidence. When a
 * complaint arrives months later, this page is the answer.
 *
 * Consent is changed on the customer's own file, not here: the change belongs
 * next to the person it is about, and a bulk-editing surface for permissions is
 * exactly the affordance that should not exist.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import {
  CONSENT_CHANNEL_LABELS,
  CONSENT_SOURCE_LABELS,
  type ConsentChannel,
  type ConsentSource,
} from "@/lib/crm-shared";
import { EmptyState, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox } from "@/app/dashboard/ui";
import { crmCustomerHref } from "./crm-routes";

interface Coverage {
  total: number;
  smsGranted: number;
  emailGranted: number;
  smsReachable: number;
  emailReachable: number;
}

interface ConsentEvent {
  id: string;
  customerId: string;
  customerName: string;
  channel: ConsentChannel;
  granted: boolean;
  source: ConsentSource;
  note: string;
  changedBy: string;
  createdAt: string;
}

export function ConsentSection() {
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [events, setEvents] = useState<ConsentEvent[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback((signal?: AbortSignal) => {
    setRefreshing(true);
    return api<{ coverage: Coverage; events: ConsentEvent[] }>("/api/crm/consent", { signal }).then(
      ({ ok, data, aborted }) => {
        // A superseded/cancelled request must not clobber fresher state or
        // flip the busy flags on an unmounted component.
        if (aborted) return;
        if (ok) {
          setCoverage(data.coverage);
          setEvents(data.events);
          // Clear a stale error so a recovered reload does not keep showing
          // the previous failure.
          setError("");
        } else {
          setError("بارگذاری سابقهٔ رضایت ناموفق بود.");
        }
        setLoading(false);
        setRefreshing(false);
      },
    );
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // First load still in flight: a content-shaped skeleton, not a spinner.
  if (loading) {
    return <SectionCardSkeleton rows={4} />;
  }

  // The load finished but failed — show the error and a way back, instead of
  // leaving the skeleton up forever (a network blip must not strand the page).
  if (!coverage) {
    return (
      <div className="min-w-0 space-y-4">
        <ErrorBox>{error || "بارگذاری سابقهٔ رضایت ناموفق بود."}</ErrorBox>
        <SectionCard
          title={
            <div>
              <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">حریم و رضایت</p>
              <h2 className="mt-1 text-base sm:text-lg font-semibold text-stone-950 dark:text-stone-100">پوشش رضایت ارتباط</h2>
            </div>
          }
        >
          <EmptyState>بارگذاری اطلاعات رضایت ناموفق بود.</EmptyState>
          <div className="mt-3 flex justify-center">
            <Button type="button" variant="outline" size="sm" onClick={() => load()} disabled={refreshing}>
              <RefreshCwIcon aria-hidden="true" className="size-4" />
              {refreshing ? "در حال تلاش…" : "تلاش دوباره"}
            </Button>
          </div>
        </SectionCard>
      </div>
    );
  }

  const percent = (part: number) =>
    coverage.total === 0 ? "۰" : toPersianDigits(String(Math.round((part / coverage.total) * 100)));

  return (
    <div className="min-w-0 space-y-4">
      <ErrorBox>{error}</ErrorBox>

      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">حریم و رضایت</p>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-foreground">پوشش رضایت ارتباط</h2>
          </div>
        }
        description="چه سهمی از مشتریان اجازه داده‌اند، و چه سهمی واقعاً قابل ارسال‌اند."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <CoverageBlock
            label="پیامک"
            total={coverage.total}
            granted={coverage.smsGranted}
            reachable={coverage.smsReachable}
            percent={percent}
            missingHint="اجازه داده‌اند اما شماره‌ای در پرونده‌شان نیست."
          />
          <CoverageBlock
            label="ایمیل"
            total={coverage.total}
            granted={coverage.emailGranted}
            reachable={coverage.emailReachable}
            percent={percent}
            missingHint="اجازه داده‌اند اما ایمیلی در پرونده‌شان نیست."
          />
        </div>
        <p className="mt-3 text-xs leading-6 text-muted-foreground">
          بخش‌بندی و هر ارسال آینده، عدد «قابل ارسال» را ملاک می‌گیرد؛ فیلتر رضایت در خود پرس‌وجو
          اعمال می‌شود، نه در ظاهر صفحه، تا مشتری بدون اجازه اصلاً در فهرست نیاید.
        </p>
      </SectionCard>

      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">ممیزی رضایت</p>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-foreground">سابقهٔ تغییرات رضایت</h2>
          </div>
        }
        description="فقط افزودنی است؛ هیچ ردیفی ویرایش یا حذف نمی‌شود."
        actions={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => load()}
            disabled={refreshing}
            aria-label="بازخوانی"
            aria-busy={refreshing}
          >
            <RefreshCwIcon aria-hidden="true" className="size-4" />
          </Button>
        }
      >
        {events.length === 0 ? (
          <EmptyState>
            هنوز تغییری در رضایت ارتباط ثبت نشده است. رضایت هر مشتری در پروندهٔ خودش تغییر می‌کند.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border/80 text-sm">
            {events.map((event) => (
              <li key={event.id} className="flex flex-wrap items-start justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="leading-6 text-foreground">
                    <Link href={crmCustomerHref(event.customerId)} className="font-medium hover:underline">
                      {event.customerName}
                    </Link>{" "}
                    {event.granted ? "اجازهٔ" : "لغو اجازهٔ"} {CONSENT_CHANNEL_LABELS[event.channel]}
                  </p>
                  {event.note ? (
                    <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{event.note}</p>
                  ) : null}
                  <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <StatusBadge tone={event.granted ? "positive" : "neutral"}>
                      {CONSENT_SOURCE_LABELS[event.source] ?? event.source}
                    </StatusBadge>
                    {event.changedBy ? <span>{event.changedBy}</span> : null}
                    {/* An audit trail needs the time of day, not just the date:
                        the whole question this page answers is *when* a flag
                        flipped. */}
                    <time dateTime={event.createdAt}>
                      {toPersianDigits(formatJalali(event.createdAt, { withTime: true }))}
                    </time>
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

function CoverageBlock({
  label,
  total,
  granted,
  reachable,
  percent,
  missingHint,
}: {
  label: string;
  total: number;
  granted: number;
  reachable: number;
  percent: (part: number) => string;
  missingHint: string;
}) {
  // Clamp so a stray count above the base (e.g. reachable > total from a data
  // race) can never overflow the track or report >100%.
  const unreachable = Math.max(0, granted - reachable);
  const ratio = total === 0 ? 0 : Math.min(1, Math.max(0, reachable / total));
  const percentValue = Math.round(ratio * 100);
  return (
    <div className="min-w-0 rounded-2xl border border-border/80 p-4">
      <p className="text-sm font-semibold text-foreground">{label}</p>
      <p className="mt-2 text-2xl font-bold tracking-tight text-teal-700 dark:text-teal-300">
        {formatPersianNumber(reachable)}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        قابل ارسال · {percent(reachable)}٪ از {formatPersianNumber(total)} مشتری
      </p>
      <div
        className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={`سهم قابل ارسال ${label}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percentValue}
        aria-valuetext={`${toPersianDigits(String(percentValue))}٪`}
      >
        <span
          className="block h-full bg-teal-500 dark:bg-teal-500"
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {formatPersianNumber(granted)} نفر رضایت داده‌اند.
        {unreachable > 0 ? ` ${formatPersianNumber(unreachable)} نفر از آن‌ها ${missingHint}` : ""}
      </p>
    </div>
  );
}
