"use client";

import { SectionCardSkeleton } from "@/app/dashboard/page-chrome";

/**
 * The Growth app's management dashboard (Phase 36b) — its «داشبورد».
 *
 * Every number here is read from the same tables the section screens write
 * to, and every balance is the ledger's own (the bridge card reconstructs
 * them from journal lines, exactly like the trial balance). The dashboard's
 * one job is to make the state of marketing legible at a glance and to be one
 * tap away from the screen that acts on it — hence quick actions that jump
 * between sections, and the bridge card that jumps into accounting.
 */

import { useCallback, useEffect, useState } from "react";
import { ArrowLeftIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMoney } from "@/components/money/money-context";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import type { GrowthOverview } from "@/lib/growth-overview";
import { cardClass, EmptyState, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox } from "@/app/dashboard/ui";
import type { GrowthSectionKey } from "./growth-routes";

const CAMPAIGN_STATE_LABELS: Record<string, string> = {
  live: "در حال اجرا",
  scheduled: "زمان‌بندی‌شده",
  ended: "پایان‌یافته",
  paused: "متوقف",
};

const ACTIVITY_KIND_LABELS: Record<string, string> = {
  campaign: "کمپین",
  points: "وفاداری",
  gift_card: "کارت هدیه",
  commission: "پورسانت",
};

/** A KPI tile: cardClass composed, not restated (design-lint holds this line). */
function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className={`min-w-0 p-4 sm:p-5 ${cardClass}`}>
      <p className="text-xs font-medium leading-5 text-muted-foreground">{label}</p>
      <p className="mt-2 truncate text-xl font-bold tracking-tight text-foreground sm:text-2xl">{value}</p>
      {hint ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function OverviewSection({ onGoToSection }: { onGoToSection: (key: GrowthSectionKey) => void }) {
  const money = useMoney();
  const [overview, setOverview] = useState<GrowthOverview | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setError("");
    api<{ overview: GrowthOverview }>("/api/growth/overview").then(({ ok, data }) => {
      if (ok) setOverview(data.overview);
      else setError("بارگذاری میز کار رشد ناموفق بود.");
    });
  }, []);
  useEffect(load, [load]);

  // A failed first read must say so and offer a retry: the skeleton alone
  // would spin forever, with the error stranded under the early return below.
  if (!overview && error) {
    return (
      <div className="space-y-4">
        <ErrorBox>{error}</ErrorBox>
        <div>
          <Button variant="outline" className="min-h-11" onClick={load}>
            تلاش دوباره
          </Button>
        </div>
      </div>
    );
  }
  if (!overview) {
    return (
      <SectionCardSkeleton rows={4} />
    );
  }

  const storeCredit = overview.bridge.find((row) => row.code === "2410")?.balance ?? 0;
  const firstRun =
    overview.campaigns.list.length === 0 && overview.loyalty.programs === 0;

  return (
    <div className="space-y-4 sm:space-y-5">
      <ErrorBox>{error}</ErrorBox>

      {firstRun ? (
        <SectionCard
          title={
            <div>
              <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">شروع سریع</p>
              <h2 className="mt-1 text-base sm:text-lg font-semibold text-stone-950 dark:text-stone-100">شروع برنامهٔ رشد</h2>
            </div>
          }
          description="سه قدم کوچک برای شروع برنامهٔ رشد و بازاریابی."
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <Button variant="outline" className="min-h-11 justify-start" onClick={() => onGoToSection("campaigns")}>
              ۱. اولین کمپین تخفیف را بساز
            </Button>
            <Button variant="outline" className="min-h-11 justify-start" onClick={() => onGoToSection("loyalty")}>
              ۲. برنامهٔ وفاداری را تعریف کن
            </Button>
            <Button variant="outline" className="min-h-11 justify-start" onClick={() => onGoToSection("commission")}>
              ۳. پورسانت فروشندگان را فعال کن
            </Button>
          </div>
        </SectionCard>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard
          label="تخفیف کمپین‌ها · ۳۰ روز گذشته"
          value={money.format(overview.campaigns.discountRial)}
          hint={`${formatPersianNumber(overview.campaigns.applications)} بار اعمال روی فروش · ${formatPersianNumber(overview.campaigns.counts.live)} کمپین در حال اجرا`}
        />
        <StatCard
          label="بدهی کارت هدیه (۲۴۲۰)"
          value={money.format(overview.giftCards.outstandingRial)}
          hint={`${formatPersianNumber(overview.giftCards.issued30d)} کارت در ۳۰ روز گذشته صادر شد`}
        />
        <StatCard
          label="اعتبار فروشگاهی مشتریان (۲۴۱۰)"
          value={money.format(storeCredit)}
          hint={`${formatPersianNumber(overview.loyalty.customersWithPoints)} مشتری از ${formatPersianNumber(overview.loyalty.customersTotal)} صاحب امتیاز است`}
        />
        <StatCard
          label="پورسانت فروشندگان · ۳۰ روز گذشته"
          value={money.format(overview.commission.accrued30d)}
          hint="هزینه ۵۲۱۰، بدهی حقوق ۲۳۰۰"
        />
        <StatCard
          label="امتیاز در گردش"
          value={formatPersianNumber(overview.loyalty.pointsOutstanding)}
          hint={`ارزش تخمینی بازخرید ${money.format(overview.loyalty.pointsValueEstimate)} · ${formatPersianNumber(overview.loyalty.redeemed30d)} امتیاز در ۳۰ روز خرج شد`}
        />
        <StatCard
          label="آمادهٔ خرید مجدد (این شعبه)"
          value={formatPersianNumber(overview.repurchase.due)}
          hint="مشتریانی که موعد خرید دوباره‌شان گذشته است"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title={
            <div>
              <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">کمپین‌های تخفیف</p>
              <h2 className="mt-1 text-base sm:text-lg font-semibold text-stone-950 dark:text-stone-100">برترین کمپین‌ها</h2>
            </div>
          }
          description="بیشترین تخفیف مصرف‌شده در ۳۰ روز گذشته"
          actions={
            <Button variant="ghost" size="xs" onClick={() => onGoToSection("campaigns")}>
              همهٔ کمپین‌ها
              <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
            </Button>
          }
        >
          {overview.campaigns.top.length === 0 ? (
            <EmptyState>هنوز کمپینی روی فروشی اعمال نشده است.</EmptyState>
          ) : (
            <ul className="divide-y divide-border/80 text-sm">
              {overview.campaigns.top.map((row) => (
                <li key={row.promotionId} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <span className="font-medium text-foreground">{row.promotionName}</span>
                    <span className="mr-2 text-xs text-muted-foreground">
                      {formatPersianNumber(row.applications)} بار اعمال
                    </span>
                  </div>
                  <span className="shrink-0 font-semibold text-amber-700 dark:text-amber-300">{money.format(row.discountRial)}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title={
            <div>
              <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">پورسانت فروش</p>
              <h2 className="mt-1 text-base sm:text-lg font-semibold text-stone-950 dark:text-stone-100">برترین فروشندگان</h2>
            </div>
          }
          description="پورسانت انباشته در ۳۰ روز گذشته"
          actions={
            <Button variant="ghost" size="xs" onClick={() => onGoToSection("commission")}>
              رتبه‌بندی کامل
              <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
            </Button>
          }
        >
          {overview.commission.top.length === 0 ? (
            <EmptyState>هنوز پورسانتی ثبت نشده است.</EmptyState>
          ) : (
            <ul className="divide-y divide-border/80 text-sm">
              {overview.commission.top.map((row) => (
                <li key={row.employeeId} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="min-w-0 font-medium text-foreground">{row.employeeName}</span>
                  <span className="shrink-0 font-semibold text-emerald-700 dark:text-emerald-300">{money.format(row.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title={
            <div>
              <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">رویدادهای سیستم</p>
              <h2 className="mt-1 text-base sm:text-lg font-semibold text-stone-950 dark:text-stone-100">آخرین رویدادهای رشد</h2>
            </div>
          }
          description="جریان یکپارچهٔ چهار موتور: کمپین، امتیاز، کارت هدیه و پورسانت"
          actions={
            <Button variant="ghost" size="icon-sm" onClick={load} aria-label="بازخوانی">
              <RefreshCwIcon aria-hidden="true" className="size-4" />
            </Button>
          }
        >
          {overview.activity.length === 0 ? (
            <EmptyState>هنوز رویدادی ثبت نشده است؛ اولین فروش با کمپین یا امتیاز، اینجا ظاهر می‌شود.</EmptyState>
          ) : (
            <ul className="divide-y divide-border/80 text-sm">
              {overview.activity.map((row, index) => (
                <li key={`${row.at}-${index}`} className="flex items-start justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="leading-6 text-foreground">{activityText(row, money.format.bind(money))}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      <StatusBadge tone="neutral">{ACTIVITY_KIND_LABELS[row.kind] ?? row.kind}</StatusBadge>{" "}
                      <span className="ms-1">{toPersianDigits(formatJalali(row.at))}</span>
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

      </div>
    </div>
  );
}

/** One activity row, as one Persian sentence — the feed reads like a log, not a table. */
function activityText(
  row: GrowthOverview["activity"][number],
  formatMoney: (value: number) => string,
): string {
  switch (row.kind) {
    case "campaign":
      return `کمپین «${row.subject}» ${formatMoney(row.amount)} تخفیف داد.`;
    case "gift_card":
      return `کارت هدیه ${toPersianDigits(row.subject)} به ارزش ${formatMoney(row.amount)} صادر شد.`;
    case "commission":
      return `پورسانت ${formatMoney(row.amount)} برای ${row.subject} ثبت شد.`;
    case "points":
      return row.amount < 0
        ? `${row.subject} ${formatPersianNumber(Math.abs(row.amount))} امتیاز به اعتبار فروشگاهی تبدیل کرد.`
        : `${row.subject} ${formatPersianNumber(row.amount)} امتیاز گرفت.`;
    default:
      return row.subject;
  }
}
