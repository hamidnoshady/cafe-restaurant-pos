"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMoney } from "@/components/money/money-context";
import { formatPersianNumber } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { ledgerSourceLabel } from "@/lib/ledger-source-labels";
import { cardClass, EmptyState, SectionCard, SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox } from "@/app/dashboard/ui";
import type { AccountingSectionKey } from "./accounting-routes";

/**
 * The Accounting app's dashboard (Phase «حسابداری» home) — its «داشبورد».
 *
 * Every number is the ledger's own: the endpoint reads `journal_lines` the
 * same way the trial balance does, so this screen reports the books rather
 * than a second source that could drift from them. The quick actions jump to
 * the screen that acts on each number, the way the Growth and CRM work desks
 * do.
 */

interface LedgerOverview {
  balanced: boolean;
  totalDebit: number;
  totalCredit: number;
  cashAndBank: number;
  receivables: number;
  payables: number;
  revenue: number;
  expenses: number;
  netIncome: number;
  openReceivableCheques: number;
  openPayableCheques: number;
  recentEntries: {
    id: string;
    date: string;
    memo: string | null;
    sourceType: string | null;
    total: number;
  }[];
}

/** A KPI tile: cardClass composed, not restated (design-lint holds this line). */
function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className={`min-w-0 p-4 sm:p-5 ${cardClass}`}>
      <p className="text-xs font-medium leading-5 text-muted-foreground">{label}</p>
      <p className="mt-2 truncate text-xl font-bold tracking-tight text-foreground sm:text-2xl">{value}</p>
      {hint ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function LedgerDashboardSection({
  onGoToTab,
  refreshKey,
}: {
  onGoToTab: (key: AccountingSectionKey) => void;
  refreshKey: number;
}) {
  const money = useMoney();
  const [overview, setOverview] = useState<LedgerOverview | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setError("");
    api<{ overview: LedgerOverview }>("/api/ledger/overview").then(({ ok, data }) => {
      if (ok) setOverview(data.overview);
      else setError("بارگذاری داشبورد حسابداری ناموفق بود.");
    });
  }, []);
  useEffect(load, [load, refreshKey]);

  if (!overview) {
    // The skeleton must not outlive a request that failed — the error box did
    // render, but underneath a spinner-shaped placeholder that never resolved.
    return (
      <>
        <ErrorBox>{error}</ErrorBox>
        {error ? null : <SectionCardSkeleton rows={4} label="در حال بارگذاری داشبورد حسابداری" />}
      </>
    );
  }

  const hasActivity = overview.totalDebit !== 0 || overview.totalCredit !== 0;

  return (
    <div className="space-y-4 sm:space-y-5">
      <ErrorBox>{error}</ErrorBox>

      {!hasActivity ? (
        <SectionCard
          title={
            <div>
              <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">شروع سریع</p>
              <h2 className="mt-1 text-base font-semibold text-stone-950 dark:text-stone-100 sm:text-lg">
                دفتر شما هنوز خالی است
              </h2>
            </div>
          }
          description="اولین سند را ثبت کنید تا تراز، دریافتی‌ها و پرداختی‌ها اینجا شکل بگیرند."
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <Button variant="outline" className="min-h-11 justify-start" onClick={() => onGoToTab("manual")}>
              ۱. اولین سند دستی را ثبت کن
            </Button>
            <Button variant="outline" className="min-h-11 justify-start" onClick={() => onGoToTab("chart-of-accounts")}>
              ۲. سرفصل حساب‌ها را بازبینی کن
            </Button>
            <Button variant="outline" className="min-h-11 justify-start" onClick={() => onGoToTab("fiscal-periods")}>
              ۳. دورهٔ مالی را تعریف کن
            </Button>
          </div>
        </SectionCard>
      ) : null}

      {overview.balanced ? (
        <StatusBadge tone="positive">دفتر متوازن است — جمع بدهکار و بستانکار برابر است.</StatusBadge>
      ) : (
        <StatusBadge tone="danger">دفتر نامتوازن است — اسناد ثبت‌شده را بازبینی کنید.</StatusBadge>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard
          label="نقدینگی (صندوق و بانک)"
          value={money.format(overview.cashAndBank)}
          hint="حساب‌های ۱۱۰۰ تا ۱۱۳۰"
        />
        <StatCard
          label="دریافتنی‌ها"
          value={money.format(overview.receivables)}
          hint={`${formatPersianNumber(overview.openReceivableCheques)} چک دریافتی باز`}
        />
        <StatCard
          label="پرداختنی‌ها"
          value={money.format(overview.payables)}
          hint={`${formatPersianNumber(overview.openPayableCheques)} چک صادرشدهٔ باز`}
        />
        <StatCard label="درآمد" value={money.format(overview.revenue)} />
        <StatCard label="هزینه‌ها" value={money.format(overview.expenses)} />
        <StatCard label="سود (زیان) خالص" value={money.format(overview.netIncome)} />
      </div>

      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">دسترسی سریع</p>
            <h2 className="mt-1 text-base font-semibold text-stone-950 dark:text-stone-100">کارهای رایج</h2>
          </div>
        }
        description="از اینجا مستقیم به بخشی بروید که باید در آن کار کنید."
      >
        {/*
          The whole workspace, not only the ledger: «اشخاص» و «گزارش‌های مالی»
          are top-level areas of this app now, and a home screen whose shortcuts
          all pointed into «فضای کار حسابداری» was exactly what made Accounting
          read as a ledger tool. The rest of the business (فروش، خرید، انبار،
          محصولات) is in the app's sidebar, gated once by the shell.
        */}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="min-h-11 justify-start" onClick={() => onGoToTab("directory")}>
            اشخاص
          </Button>
          <Button variant="outline" className="min-h-11 justify-start" onClick={() => onGoToTab("receivables")}>
            حساب‌های دریافتنی
          </Button>
          <Button variant="outline" className="min-h-11 justify-start" onClick={() => onGoToTab("payables")}>
            حساب‌های پرداختنی
          </Button>
          <Button variant="outline" className="min-h-11 justify-start" onClick={() => onGoToTab("manual")}>
            ثبت سند دستی
          </Button>
          <Button variant="outline" className="min-h-11 justify-start" onClick={() => onGoToTab("entries")}>
            دفتر روزنامه
          </Button>
          <Button variant="outline" className="min-h-11 justify-start" onClick={() => onGoToTab("cheques")}>
            چک‌ها
          </Button>
          <Button variant="outline" className="min-h-11 justify-start" onClick={() => onGoToTab("reconciliation")}>
            تطبیق بانکی
          </Button>
          <Button variant="outline" className="min-h-11 justify-start" onClick={() => onGoToTab("reports")}>
            گزارش‌های مالی
          </Button>
        </div>
      </SectionCard>

      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">آخرین رویدادها</p>
            <h2 className="mt-1 text-base font-semibold text-stone-950 dark:text-stone-100">اسناد اخیر</h2>
          </div>
        }
        description="پنج سند آخر ثبت‌شده، از جدیدترین."
      >
        {overview.recentEntries.length === 0 ? (
          <EmptyState>هنوز سندی ثبت نشده است.</EmptyState>
        ) : (
          <ul className="divide-y divide-border/80">
            {overview.recentEntries.map((entry) => (
              <li key={entry.id} className="flex items-center gap-3 py-2.5">
                <span className="min-w-0 flex-1 truncate text-sm text-foreground/80">
                  {entry.memo?.trim() || "سند بدون شرح"}
                  {/* What posted it — a fact the endpoint already returned and this
                      list dropped, leaving five look-alike rows. */}
                  <span className="ms-2 text-xs text-muted-foreground">{ledgerSourceLabel(entry.sourceType)}</span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatJalali(entry.date)}
                </span>
                <span className="w-28 shrink-0 text-end text-sm font-bold text-foreground">
                  {money.format(entry.total)}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="بازکردن دفتر روزنامه"
                  onClick={() => onGoToTab("entries")}
                >
                  <ArrowLeftIcon className="size-4" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
