"use client";

import { SectionCardSkeleton } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { JalaliDatePicker } from "../jalali-date-picker";
import { api, errorMessage, inputClass, PrimaryButton, SecondaryButton } from "../ui";
import type { Runner } from "./ledger-manager";
import { cardClass } from "../page-chrome";

interface StaffWage {
  id: string;
  fullName: string;
  role: string;
  monthlyWage: number | null;
}

interface PayrollRunLine {
  userId: string | null;
  fullName: string | null;
  amount: number;
}

interface PayrollRun {
  id: string;
  periodLabel: string;
  status: "accrued" | "paid";
  totalAmount: number;
  accrualDate: string;
  paidDate: string | null;
  createdByName: string | null;
  lines: PayrollRunLine[];
}

/**
 * Journal-level payroll — staff cost accrual and payment, not a payroll
 * engine (no tax tables, insurance, or payslips). Restricted to owner and
 * accountant: wages are compensation data, more sensitive than the rest of
 * this phase's ledger surfaces, which managers can otherwise post to freely.
 */
export function PayrollSection({ busy, run, refreshKey }: { busy: boolean; run: Runner; refreshKey: number }) {
  const money = useMoney();
  const [staff, setStaff] = useState<StaffWage[] | null>(null);
  const [runs, setRuns] = useState<PayrollRun[] | null>(null);
  const [wageInputs, setWageInputs] = useState<Record<string, string>>({});
  const [periodLabel, setPeriodLabel] = useState("");
  const [accrualDate, setAccrualDate] = useState("");
  const [localError, setLocalError] = useState("");

  function load() {
    api<{ staff: StaffWage[] }>("/api/ledger/payroll/staff").then(({ ok, data }) => {
      if (ok) {
        setStaff(data.staff);
        setWageInputs(
          Object.fromEntries(data.staff.map((s) => [s.id, s.monthlyWage != null ? String(money.toInput(s.monthlyWage)) : ""])),
        );
      }
    });
    api<{ runs: PayrollRun[] }>("/api/ledger/payroll/runs").then(({ ok, data }) => {
      if (ok) setRuns(data.runs);
    });
  }

  useEffect(load, [refreshKey]);

  async function saveWage(userId: string) {
    setLocalError("");
    const raw = wageInputs[userId] ?? "";
    let rial: number | null = null;
    if (raw.trim()) {
      try {
        rial = money.parse(raw);
      } catch {
        return setLocalError("مبلغ حقوق معتبر نیست.");
      }
    }
    const { ok, data } = await api("/api/ledger/payroll/staff/" + userId, {
      method: "PATCH",
      body: JSON.stringify({ monthlyWage: rial }),
    });
    if (!ok) return setLocalError(errorMessage((data as { error?: string }).error));
    load();
  }

  async function accrue(e: React.FormEvent) {
    e.preventDefault();
    if (!periodLabel.trim()) return;
    const ok = await run(() =>
      api("/api/ledger/payroll/runs", {
        method: "POST",
        body: JSON.stringify({ periodLabel, accrualDate: accrualDate || undefined }),
      }),
    );
    if (ok) {
      setPeriodLabel("");
      setAccrualDate("");
    }
  }

  async function pay(runId: string) {
    await run(() => api("/api/ledger/payroll/runs/" + runId + "/pay", { method: "POST", body: JSON.stringify({ method: "cash" }) }));
  }

  if (!staff || !runs) {
    return (
      <SectionCardSkeleton rows={4} />
    );
  }

  return (
    <div className="space-y-5">
      <section aria-labelledby="payroll-wages-heading" className={`${cardClass} p-4 sm:p-5`}>
        <header className="mb-5 border-b border-border pb-4">
          <p className="text-xs font-semibold text-amber-700">تنظیمات حقوق</p>
          <h2 id="payroll-wages-heading" className="mt-1 text-lg font-bold">حقوق ماهانه کارکنان</h2>
          <p className="mt-1 text-sm text-muted-foreground">مبلغ حقوق هر کارمند را به تومان وارد و ذخیره کنید.</p>
        </header>

        {localError ? (
          <p role="alert" className="mb-4 rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {localError}
          </p>
        ) : null}

        {staff.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border bg-stone-50 px-4 py-8 text-center text-sm text-muted-foreground">
            عضو فعالی یافت نشد.
          </p>
        ) : (
          <div className="space-y-3">
            {staff.map((s) => (
              <div key={s.id} className="grid gap-3 rounded-xl border border-border bg-stone-50 p-4 md:grid-cols-[minmax(10rem,1fr)_minmax(12rem,15rem)_auto] md:items-end">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">کارمند</p>
                  <p className="mt-1 font-semibold">{s.fullName}</p>
                </div>
                <label className="block text-sm font-medium">
                  <span className="mb-1.5 block text-xs text-muted-foreground">حقوق ماهانه ({money.unitLabel})</span>
                  <PersianNumberInput
                    className={inputClass + " w-full"}
                    dir="ltr"
                    inputMode="numeric"
                    value={wageInputs[s.id] ?? ""}
                    onChange={(e) => setWageInputs((prev) => ({ ...prev, [s.id]: e.target.value }))}
                    placeholder={`حقوق ماهانه (${money.unitLabel})`}
                    aria-label={"حقوق ماهانه " + s.fullName}
                  />
                </label>
                <div className="min-w-32">
                  <SecondaryButton onClick={() => saveWage(s.id)} disabled={busy}>
                    ذخیره
                  </SecondaryButton>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="payroll-accrual-heading" className={`${cardClass} p-4 sm:p-5`}>
        <header className="mb-5 border-b border-border pb-4">
          <p className="text-xs font-semibold text-amber-700">ثبت دوره</p>
          <h2 id="payroll-accrual-heading" className="mt-1 text-lg font-bold">تعهد حقوق و دستمزد جدید</h2>
          <p className="mt-1 text-sm text-muted-foreground">ثبت تعهد، همان گردش سندداری موجود را اجرا می‌کند.</p>
        </header>
        <form onSubmit={accrue} className="grid gap-4 md:grid-cols-[minmax(14rem,1fr)_12rem_auto] md:items-end">
          <label className="block text-sm font-medium">
            <span className="mb-1.5 block text-xs text-muted-foreground">دوره</span>
            <input
              className={inputClass}
              value={periodLabel}
              onChange={(e) => setPeriodLabel(e.target.value)}
              placeholder="مثلاً مرداد ۱۴۰۴"
              required
            />
          </label>
          <label className="block text-sm font-medium">
            <span className="mb-1.5 block text-xs text-muted-foreground">تاریخ تعهد</span>
            <JalaliDatePicker value={accrualDate} onChange={setAccrualDate} placeholder="امروز" />
          </label>
          <div className="min-w-40">
            <PrimaryButton disabled={busy || !periodLabel.trim()}>ثبت تعهد</PrimaryButton>
          </div>
        </form>
      </section>

      <section aria-labelledby="payroll-history-heading" className={`${cardClass} p-4 sm:p-5`}>
        <header className="mb-5 border-b border-border pb-4">
          <p className="text-xs font-semibold text-amber-700">سوابق</p>
          <h2 id="payroll-history-heading" className="mt-1 text-lg font-bold">تاریخچه حقوق و دستمزد</h2>
        </header>

        {runs.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border bg-stone-50 px-4 py-8 text-center text-sm text-muted-foreground">
            هنوز تعهدی ثبت نشده است.
          </p>
        ) : (
          <ul className="space-y-3">
            {runs.map((r) => (
              <li key={r.id} className="rounded-xl border border-border bg-stone-50 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
                  <div>
                    <h3 className="font-semibold">{r.periodLabel}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">{toPersianDigits(formatJalali(r.accrualDate))}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold tabular-nums">{money.format(r.totalAmount)}</span>
                    <span className={"rounded-full px-2.5 py-1 text-xs font-semibold " + (r.status === "paid" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800")}>
                      {r.status === "paid" ? "پرداخت‌شده" : "تعهدشده"}
                    </span>
                  </div>
                </div>

                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {r.lines.map((l, i) => (
                    <div key={i} className="flex items-center justify-between gap-3 rounded-lg bg-stone-50 px-3 py-2.5 text-sm">
                      <span className="min-w-0 truncate text-muted-foreground">{l.fullName ?? "—"}</span>
                      <span className="shrink-0 font-semibold tabular-nums">{money.format(l.amount)}</span>
                    </div>
                  ))}
                </div>

                {r.status === "accrued" ? (
                  <div className="mt-4 max-w-xs">
                    <SecondaryButton onClick={() => pay(r.id)} disabled={busy}>
                      پرداخت (از صندوق)
                    </SecondaryButton>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
