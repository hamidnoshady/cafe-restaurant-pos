"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali, todayJalali } from "@/lib/jalali";
import { Button } from "@/components/ui/button";
import { api, ErrorBox, inputClass, PrimaryButton, SecondaryButton } from "../ui";
import type { Runner } from "./accounting-manager";
import { cardClass } from "../page-chrome";

interface FiscalYear {
  id: string;
  label: string;
  startsOn: string;
  endsOn: string;
  closedAt: string | null;
}

type PeriodStatus = "open" | "soft_closed" | "locked";

interface FiscalPeriod {
  id: string;
  fiscalYearId: string;
  label: string;
  name: string;
  startsOn: string;
  endsOn: string;
  status: PeriodStatus;
  softClosedAt: string | null;
  lockedAt: string | null;
  reopenedAt: string | null;
}

const STATUS_LABELS: Record<PeriodStatus, string> = {
  open: "باز",
  soft_closed: "بسته‌ی موقت",
  locked: "قفل‌شده",
};

const STATUS_STYLES: Record<PeriodStatus, string> = {
  open: "bg-emerald-100 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-200",
  soft_closed: "bg-amber-100 text-amber-950 dark:bg-amber-500/20 dark:text-amber-200",
  locked: "bg-destructive/10 text-destructive",
};

function errorMessage(code: string | undefined): string {
  const map: Record<string, string> = {
    invalid_year: "سال شمسی نامعتبر است.",
    fiscal_year_exists: "این سال مالی قبلاً تعریف شده است.",
    period_not_found: "دوره یافت نشد.",
    invalid_transition: "این تغییر وضعیت برای دوره مجاز نیست.",
    fiscal_year_closed: "سال مالی این دوره قبلاً بسته شده و دیگر قابل بازگشایی نیست.",
    fiscal_year_not_found: "سال مالی یافت نشد.",
    fiscal_year_already_closed: "این سال مالی قبلاً بسته شده است.",
    periods_not_ready: "برای بستن سال مالی، ابتدا باید همه دوره‌های آن به‌صورت موقت بسته شوند.",
    period_locked_for_closing: "دوره پایانی سال قفل است؛ ابتدا آن را بازگشایی و دوباره بسته‌ی موقت کنید.",
    ledger_account_missing: "حساب «سود (زیان) انباشته» در سرفصل حساب‌ها یافت نشد.",
    unauthorized: "وارد نشده‌اید.",
    forbidden: "دسترسی مجاز نیست.",
    bad_request: "درخواست نامعتبر بود.",
  };
  return map[code ?? ""] ?? "خطای غیرمنتظره. دوباره تلاش کنید.";
}

export function FiscalPeriodsSection({
  busy,
  run,
}: {
  busy: boolean;
  run: Runner;
}) {
  const [years, setYears] = useState<FiscalYear[] | null>(null);
  const [selectedYearId, setSelectedYearId] = useState<string | null>(null);
  const [periods, setPeriods] = useState<FiscalPeriod[] | null>(null);
  const [newYear, setNewYear] = useState(String(todayJalali().jy));
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [closing, setClosing] = useState(false);
  const [creatingYear, setCreatingYear] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    api<{ fiscalYears: FiscalYear[] }>("/api/ledger/fiscal-years").then(({ ok, data }) => {
      // `return` alone left the skeleton up for ever, which reads as "still
      // loading" rather than "this did not load".
      if (!ok) {
        setYears([]);
        setLoadFailed(true);
        return;
      }
      setYears(data.fiscalYears);
      setSelectedYearId((prev) => prev ?? data.fiscalYears[0]?.id ?? null);
    });
  }, [refreshKey]);

  useEffect(() => {
    if (!selectedYearId) {
      setPeriods(null);
      return;
    }
    api<{ periods: FiscalPeriod[] }>(`/api/ledger/fiscal-years/${selectedYearId}/periods`).then(
      ({ ok, data }) => {
        if (ok) setPeriods(data.periods);
        else {
          setPeriods([]);
          setError("بارگذاری دوره‌های این سال مالی ناموفق بود.");
        }
      },
    );
  }, [selectedYearId, refreshKey]);

  /*
   * Posted directly rather than through `run`, so the answer comes back through
   * this section's own map: the workspace-wide one has no entry for
   * `fiscal_year_exists` or `invalid_year`, and defining a year twice therefore
   * reported «خطای غیرمنتظره» instead of saying the year already exists.
   */
  async function createYear() {
    setError("");
    const year = Number(newYear);
    if (!Number.isInteger(year)) return setError(errorMessage("invalid_year"));
    setCreatingYear(true);
    const { ok, data } = await api("/api/ledger/fiscal-years", {
      method: "POST",
      body: JSON.stringify({ year }),
    });
    setCreatingYear(false);
    if (!ok) return setError(errorMessage((data as { error?: string }).error));
    setRefreshKey((k) => k + 1);
  }

  async function setStatus(periodId: string, status: PeriodStatus) {
    setError("");
    const { ok, data } = await api(`/api/ledger/fiscal-periods/${periodId}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    if (!ok) {
      setError(errorMessage((data as { error?: string }).error));
      return;
    }
    setRefreshKey((k) => k + 1);
  }

  async function closeYear() {
    if (!selectedYearId) return;
    setError("");
    setClosing(true);
    const { ok, data } = await api(`/api/ledger/fiscal-years/${selectedYearId}/close`, { method: "POST" });
    setClosing(false);
    if (!ok) {
      setError(errorMessage((data as { error?: string }).error));
      return;
    }
    setRefreshKey((k) => k + 1);
  }

  if (!years) return <LoadingSkeleton rows={3} />;
  if (loadFailed && years.length === 0) {
    return (
      <div className="space-y-3">
        <ErrorBox>بارگذاری سال‌های مالی ناموفق بود.</ErrorBox>
        <div className="max-w-xs">
          <SecondaryButton onClick={() => setRefreshKey((k) => k + 1)}>تلاش دوباره</SecondaryButton>
        </div>
      </div>
    );
  }

  const selectedYear = years.find((y) => y.id === selectedYearId) ?? null;
  const allPeriodsSoftClosed = (periods?.length ?? 0) > 0 && periods!.every((p) => p.status === "soft_closed");

  return (
    <section className="space-y-4">
      <ErrorBox>{error}</ErrorBox>

      <div className={cardClass}>
        <header className="border-b border-border/80 px-4 py-4 sm:px-5">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">تقویم مالی</p>
          <h2 className="mt-1 text-base font-semibold text-foreground">سال‌های مالی</h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
            سال مالی و دوره‌های آن را با همان محدودیت‌های ثبت و قفل موجود مدیریت کنید.
          </p>
        </header>

        <div className="p-4 sm:p-5">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,13rem)_auto] sm:items-end">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-foreground">سال شمسی جدید</span>
              <PersianNumberInput
                type="number"
                grouping={false}
                value={newYear}
                onChange={(e) => setNewYear(e.target.value)}
                className={inputClass}
              />
            </label>
            <div className="max-w-[13rem]">
              <PrimaryButton onClick={createYear} disabled={busy || creatingYear}>
                {creatingYear ? "در حال ثبت…" : "تعریف سال مالی"}
              </PrimaryButton>
            </div>
          </div>

          {years.length === 0 ? (
            <p className="mt-5 rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
              هنوز سال مالی‌ای تعریف نشده است.
            </p>
          ) : (
            <div className="mt-5">
              <p className="mb-2 text-sm font-medium text-foreground">سال انتخاب‌شده</p>
              <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                {years.map((y) => (
                  <button
                    key={y.id}
                    type="button"
                    aria-pressed={selectedYearId === y.id}
                    onClick={() => setSelectedYearId(y.id)}
                    className={`min-h-12 rounded-xl border px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring focus-visible:ring-amber-400/40 dark:focus-visible:ring-amber-400/40 ${
                      selectedYearId === y.id
                        ? "border-amber-200 bg-amber-100 font-semibold text-amber-950 shadow-[0_1px_2px_rgb(120_53_15/0.08)] dark:border-amber-500/30 dark:bg-amber-500/20 dark:text-amber-200"
                        : "border-transparent text-muted-foreground hover:border-border hover:bg-stone-50 hover:text-foreground dark:hover:bg-stone-800/40"
                    }`}
                  >
                    {toPersianDigits(y.label)}
                    {y.closedAt ? " (بسته‌شده)" : ""}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {periods ? (
        <div className={cardClass}>
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/80 px-4 py-4 sm:px-5">
            <div>
              <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">کنترل دوره</p>
              <h2 className="mt-1 text-base font-semibold text-foreground">دوره‌های سال مالی</h2>
            </div>
            {selectedYear && !selectedYear.closedAt ? (
              <Button
                type="button"
                variant="destructive"
                disabled={closing || !allPeriodsSoftClosed}
                onClick={closeYear}
                title={allPeriodsSoftClosed ? undefined : "برای بستن سال مالی، ابتدا همه‌ی دوره‌ها را به‌صورت موقت ببندید."}
              >
                بستن سال مالی
              </Button>
            ) : null}
          </div>

          <div className="p-4 sm:p-5">
          {periods.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
              دوره‌ای برای سال انتخاب‌شده وجود ندارد.
            </p>
          ) : (
            <>
              <div className="hidden overflow-hidden rounded-xl border border-border/80 lg:block">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-stone-50 text-stone-500 dark:bg-stone-800/40 dark:text-stone-400">
                      <tr className="border-b border-border">
                        <th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">دوره</th>
                        <th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">وضعیت</th>
                        <th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">اقدام</th>
                      </tr>
                    </thead>
                    <tbody>
                      {periods.map((p) => (
                        <tr key={p.id} className="border-b border-border last:border-b-0">
                          <td className="px-4 py-3 font-medium text-foreground">
                            {toPersianDigits(p.name)}
                            {/* «دوره ۵» alone does not say which days it covers. */}
                            <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                              {toPersianDigits(formatJalali(p.startsOn))} تا {toPersianDigits(formatJalali(p.endsOn))}
                            </span>
                          </td>
                          <td className="px-4 py-3"><span className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_STYLES[p.status]}`}>{STATUS_LABELS[p.status]}</span></td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap gap-2">
                              {p.status === "open" ? <button type="button" onClick={() => setStatus(p.id, "soft_closed")} className="rounded-lg px-3 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-500/20">بستن موقت</button> : null}
                              {p.status === "soft_closed" ? (
                                <>
                                  <button type="button" onClick={() => setStatus(p.id, "locked")} className="rounded-lg px-3 text-xs font-semibold text-destructive transition-colors hover:bg-destructive/10">قفل کردن</button>
                                  <button type="button" onClick={() => setStatus(p.id, "open")} className="rounded-lg px-3 text-xs font-semibold text-muted-foreground transition-colors hover:bg-stone-50 hover:text-foreground dark:hover:bg-stone-800/40">بازگشایی</button>
                                </>
                              ) : null}
                              {p.status === "locked" ? <button type="button" onClick={() => setStatus(p.id, "open")} className="rounded-lg px-3 text-xs font-semibold text-muted-foreground transition-colors hover:bg-stone-50 hover:text-foreground dark:hover:bg-stone-800/40">بازگشایی</button> : null}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="space-y-3 lg:hidden">
                {periods.map((p) => (
                  <article key={p.id} className="rounded-xl border border-border/80 bg-stone-50/60 p-4 dark:bg-stone-800/30">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-foreground">{toPersianDigits(p.name)}</h3>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {toPersianDigits(formatJalali(p.startsOn))} تا {toPersianDigits(formatJalali(p.endsOn))}
                        </p>
                      </div>
                      <span className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_STYLES[p.status]}`}>{STATUS_LABELS[p.status]}</span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
                      {p.status === "open" ? <button type="button" onClick={() => setStatus(p.id, "soft_closed")} className="rounded-lg px-3 text-sm font-semibold text-amber-700 transition-colors hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-500/20">بستن موقت</button> : null}
                      {p.status === "soft_closed" ? (
                        <>
                          <button type="button" onClick={() => setStatus(p.id, "locked")} className="rounded-lg px-3 text-sm font-semibold text-destructive transition-colors hover:bg-destructive/10">قفل کردن</button>
                          <button type="button" onClick={() => setStatus(p.id, "open")} className="rounded-lg px-3 text-sm font-semibold text-muted-foreground transition-colors hover:bg-stone-50 hover:text-foreground dark:hover:bg-stone-800/40">بازگشایی</button>
                        </>
                      ) : null}
                      {p.status === "locked" ? <button type="button" onClick={() => setStatus(p.id, "open")} className="rounded-lg px-3 text-sm font-semibold text-muted-foreground transition-colors hover:bg-stone-50 hover:text-foreground dark:hover:bg-stone-800/40">بازگشایی</button> : null}
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
