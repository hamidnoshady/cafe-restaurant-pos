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
import { cardClass, EmptyState, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
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

  const load = useCallback(() => {
    api<{ coverage: Coverage; events: ConsentEvent[] }>("/api/crm/consent").then(({ ok, data }) => {
      if (ok) {
        setCoverage(data.coverage);
        setEvents(data.events);
      } else setError("بارگذاری سابقهٔ رضایت ناموفق بود.");
    });
  }, []);
  useEffect(load, [load]);

  if (!coverage) {
    return (
      <SectionCardSkeleton rows={4} />
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
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-stone-950 dark:text-stone-100">پوشش رضایت ارتباط</h2>
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
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-stone-950 dark:text-stone-100">سابقهٔ تغییرات رضایت</h2>
          </div>
        }
        description="فقط افزودنی است؛ هیچ ردیفی ویرایش یا حذف نمی‌شود."
        actions={
          <Button type="button" variant="ghost" size="icon-sm" onClick={load} aria-label="بازخوانی">
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
                    <span>{toPersianDigits(formatJalali(event.createdAt))}</span>
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
  const unreachable = granted - reachable;
  return (
    <div className="min-w-0 rounded-2xl border border-border/80 p-4">
      <p className="text-sm font-semibold text-foreground">{label}</p>
      <p className="mt-2 text-2xl font-bold tracking-tight text-teal-700 dark:text-teal-300">
        {formatPersianNumber(reachable)}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        قابل ارسال · {percent(reachable)}٪ از {formatPersianNumber(total)} مشتری
      </p>
      <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full bg-teal-500 dark:bg-teal-500"
          style={{ width: total === 0 ? "0%" : `${(reachable / total) * 100}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {formatPersianNumber(granted)} نفر رضایت داده‌اند.
        {unreachable > 0 ? ` ${formatPersianNumber(unreachable)} نفر از آن‌ها ${missingHint}` : ""}
      </p>
    </div>
  );
}
