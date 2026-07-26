"use client";

import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { todayJalali } from "@/lib/jalali";
import { api, ErrorBox } from "../ui";
import type { Runner } from "./ledger-manager";

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
  open: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  soft_closed: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
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

  if (!years) return <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>;

  const selectedYear = years.find((y) => y.id === selectedYearId) ?? null;
  const allPeriodsSoftClosed = (periods?.length ?? 0) > 0 && periods!.every((p) => p.status === "soft_closed");

  return (
    <section className="space-y-4">
      <ErrorBox>{error}</ErrorBox>

      <div className="rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="mb-4 font-semibold">سال‌های مالی</h2>
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">سال شمسی جدید</span>
            <input
              type="number"
              value={newYear}
              onChange={(e) => setNewYear(e.target.value)}
              className="w-32 rounded-lg border border-input bg-background px-3 py-1.5"
            />
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={createYear}
            className="rounded-lg bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground disabled:opacity-50"
          >
            تعریف سال مالی
          </button>
        </div>

        {years.length === 0 ? (
          <p className="text-sm text-muted-foreground">هنوز سال مالی‌ای تعریف نشده است.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {years.map((y) => (
              <button
                key={y.id}
                type="button"
                onClick={() => setSelectedYearId(y.id)}
                className={`rounded-lg px-3 py-1.5 text-sm ${
                  selectedYearId === y.id
                    ? "bg-primary/10 font-semibold text-primary"
                    : "text-muted-foreground hover:bg-muted"
                }`}
              >
                {toPersianDigits(y.label)}
                {y.closedAt ? " (بسته‌شده)" : ""}
              </button>
            ))}
          </div>
        )}
      </div>

      {periods ? (
        <div className="rounded-2xl bg-card p-5 shadow-sm">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold">دوره‌های سال مالی</h2>
            {selectedYear && !selectedYear.closedAt ? (
              <button
                type="button"
                disabled={closing || !allPeriodsSoftClosed}
                onClick={closeYear}
                title={
                  allPeriodsSoftClosed
                    ? undefined
                    : "برای بستن سال مالی، ابتدا همه‌ی دوره‌ها را به‌صورت موقت ببندید."
                }
                className="rounded-lg bg-destructive/10 px-4 py-1.5 text-sm font-semibold text-destructive hover:bg-destructive/20 disabled:opacity-50"
              >
                بستن سال مالی
              </button>
            ) : null}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="py-2 pe-3 text-start">دوره</th>
                  <th className="py-2 pe-3 text-start">وضعیت</th>
                  <th className="py-2 text-start">اقدام</th>
                </tr>
              </thead>
              <tbody>
                {periods.map((p) => (
                  <tr key={p.id} className="border-b border-border">
                    <td className="py-2 pe-3">{toPersianDigits(p.name)}</td>
                    <td className="py-2 pe-3">
                      <span className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_STYLES[p.status]}`}>
                        {STATUS_LABELS[p.status]}
                      </span>
                    </td>
                    <td className="py-2">
                      <div className="flex gap-2">
                        {p.status === "open" ? (
                          <button
                            type="button"
                            onClick={() => setStatus(p.id, "soft_closed")}
                            className="rounded-lg px-2 py-1 text-xs font-semibold text-amber-700 hover:bg-amber-100 dark:text-amber-400 dark:hover:bg-amber-950"
                          >
                            بستن موقت
                          </button>
                        ) : null}
                        {p.status === "soft_closed" ? (
                          <>
                            <button
                              type="button"
                              onClick={() => setStatus(p.id, "locked")}
                              className="rounded-lg px-2 py-1 text-xs font-semibold text-destructive hover:bg-destructive/10"
                            >
                              قفل کردن
                            </button>
                            <button
                              type="button"
                              onClick={() => setStatus(p.id, "open")}
                              className="rounded-lg px-2 py-1 text-xs font-semibold text-muted-foreground hover:bg-muted"
                            >
                              بازگشایی
                            </button>
                          </>
                        ) : null}
                        {p.status === "locked" ? (
                          <button
                            type="button"
                            onClick={() => setStatus(p.id, "open")}
                            className="rounded-lg px-2 py-1 text-xs font-semibold text-muted-foreground hover:bg-muted"
                          >
                            بازگشایی
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}
