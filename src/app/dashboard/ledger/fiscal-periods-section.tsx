"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { todayJalali } from "@/lib/jalali";
import { api, ErrorBox, inputClass } from "../ui";
import type { Runner } from "./ledger-manager";
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
  open: "bg-emerald-100 text-emerald-800",
  soft_closed: "bg-amber-100 text-amber-800",
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

  useEffect(() => {
    api<{ fiscalYears: FiscalYear[] }>("/api/ledger/fiscal-years").then(({ ok, data }) => {
      if (!ok) return;
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
      },
    );
  }, [selectedYearId, refreshKey]);

  async function createYear() {
    setError("");
    const ok = await run(() =>
      api("/api/ledger/fiscal-years", { method: "POST", body: JSON.stringify({ year: Number(newYear) }) }),
    );
    if (!ok) return;
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

  const selectedYear = years.find((y) => y.id === selectedYearId) ?? null;
  const allPeriodsSoftClosed = (periods?.length ?? 0) > 0 && periods!.every((p) => p.status === "soft_closed");

  return (
    <section className="space-y-4">
      <ErrorBox>{error}</ErrorBox>

      <div className={`${cardClass} p-4 sm:p-5`}>
        <p className="text-xs font-semibold text-amber-700">تقویم مالی</p>
        <h2 className="mt-1">سال‌های مالی</h2>
        <p className="mt-2 text-sm text-muted-foreground">سال مالی و دوره‌های آن را با همان محدودیت‌های ثبت و قفل موجود مدیریت کنید.</p>

        <div className="mt-5 grid gap-3 sm:grid-cols-[minmax(0,13rem)_auto] sm:items-end">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">سال شمسی جدید</span>
            <PersianNumberInput
              type="number"
              grouping={false}
              value={newYear}
              onChange={(e) => setNewYear(e.target.value)}
              className={inputClass}
            />
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={createYear}
            className="min-h-12 rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground disabled:opacity-50"
          >
            تعریف سال مالی
          </button>
        </div>

        {years.length === 0 ? (
          <p className="mt-5 rounded-xl border border-dashed border-stone-200/80 bg-stone-50 px-4 py-7 text-center text-sm text-muted-foreground">
            هنوز سال مالی‌ای تعریف نشده است.
          </p>
        ) : (
          <div className="mt-5">
            <p className="mb-2 text-sm font-medium">سال انتخاب‌شده</p>
            <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
              {years.map((y) => (
                <button
                  key={y.id}
                  type="button"
                  aria-pressed={selectedYearId === y.id}
                  onClick={() => setSelectedYearId(y.id)}
                  className={`min-h-12 rounded-xl border px-4 text-sm ${
                    selectedYearId === y.id
                      ? "border-amber-200 bg-amber-100 font-semibold text-amber-700"
                      : "border-transparent text-muted-foreground hover:border-stone-200/80 hover:bg-stone-50"
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

      {periods ? (
        <div className={`${cardClass} p-4 sm:p-5`}>
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-amber-700">کنترل دوره</p>
              <h2 className="mt-1">دوره‌های سال مالی</h2>
            </div>
            {selectedYear && !selectedYear.closedAt ? (
              <button
                type="button"
                disabled={closing || !allPeriodsSoftClosed}
                onClick={closeYear}
                title={allPeriodsSoftClosed ? undefined : "برای بستن سال مالی، ابتدا همه‌ی دوره‌ها را به‌صورت موقت ببندید."}
                className="min-h-12 rounded-xl bg-destructive/10 px-4 text-sm font-semibold text-destructive hover:bg-destructive/20 disabled:opacity-50"
              >
                بستن سال مالی
              </button>
            ) : null}
          </div>

          {periods.length === 0 ? (
            <p className="rounded-xl border border-dashed border-stone-200/80 bg-stone-50 px-4 py-7 text-center text-sm text-muted-foreground">
              دوره‌ای برای سال انتخاب‌شده وجود ندارد.
            </p>
          ) : (
            <>
              <div className="hidden overflow-x-auto lg:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="py-3 pe-3 text-start">دوره</th>
                      <th className="py-3 pe-3 text-start">وضعیت</th>
                      <th className="py-3 text-start">اقدام</th>
                    </tr>
                  </thead>
                  <tbody>
                    {periods.map((p) => (
                      <tr key={p.id} className="border-b border-border">
                        <td className="py-3 pe-3 font-medium">{toPersianDigits(p.name)}</td>
                        <td className="py-3 pe-3"><span className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_STYLES[p.status]}`}>{STATUS_LABELS[p.status]}</span></td>
                        <td className="py-3">
                          <div className="flex flex-wrap gap-2">
                            {p.status === "open" ? <button type="button" onClick={() => setStatus(p.id, "soft_closed")} className="rounded-lg px-3 text-xs font-semibold text-amber-700 hover:bg-amber-100">بستن موقت</button> : null}
                            {p.status === "soft_closed" ? (
                              <>
                                <button type="button" onClick={() => setStatus(p.id, "locked")} className="rounded-lg px-3 text-xs font-semibold text-destructive hover:bg-destructive/10">قفل کردن</button>
                                <button type="button" onClick={() => setStatus(p.id, "open")} className="rounded-lg px-3 text-xs font-semibold text-muted-foreground hover:bg-muted">بازگشایی</button>
                              </>
                            ) : null}
                            {p.status === "locked" ? <button type="button" onClick={() => setStatus(p.id, "open")} className="rounded-lg px-3 text-xs font-semibold text-muted-foreground hover:bg-muted">بازگشایی</button> : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="space-y-3 lg:hidden">
                {periods.map((p) => (
                  <article key={p.id} className="rounded-xl border border-stone-200/80 bg-stone-50 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <h3>{toPersianDigits(p.name)}</h3>
                      <span className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_STYLES[p.status]}`}>{STATUS_LABELS[p.status]}</span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2 border-t border-stone-100 pt-3">
                      {p.status === "open" ? <button type="button" onClick={() => setStatus(p.id, "soft_closed")} className="rounded-lg px-3 text-sm font-semibold text-amber-700 hover:bg-amber-100">بستن موقت</button> : null}
                      {p.status === "soft_closed" ? (
                        <>
                          <button type="button" onClick={() => setStatus(p.id, "locked")} className="rounded-lg px-3 text-sm font-semibold text-destructive hover:bg-destructive/10">قفل کردن</button>
                          <button type="button" onClick={() => setStatus(p.id, "open")} className="rounded-lg px-3 text-sm font-semibold text-muted-foreground hover:bg-muted">بازگشایی</button>
                        </>
                      ) : null}
                      {p.status === "locked" ? <button type="button" onClick={() => setStatus(p.id, "open")} className="rounded-lg px-3 text-sm font-semibold text-muted-foreground hover:bg-muted">بازگشایی</button> : null}
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
