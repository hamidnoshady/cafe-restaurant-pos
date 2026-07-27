"use client";

import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { formatToman, parseToRial, rialToToman } from "@/lib/money";
import { JalaliDatePicker } from "../jalali-date-picker";
import { api, errorMessage, inputClass, PrimaryButton, SecondaryButton } from "../ui";
import type { Runner } from "./ledger-manager";

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
          Object.fromEntries(data.staff.map((s) => [s.id, s.monthlyWage != null ? String(rialToToman(s.monthlyWage)) : ""])),
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
        rial = parseToRial(raw, "toman");
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
    await run(() => api(`/api/ledger/payroll/runs/${runId}/pay`, { method: "POST", body: JSON.stringify({ method: "cash" }) }));
  }

  if (!staff || !runs) return <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>;

  return (
    <div className="space-y-6">
      <section className="rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="mb-3 font-semibold">حقوق ماهانه کارکنان</h2>
        {localError ? <p className="mb-3 text-sm text-destructive">{localError}</p> : null}
        <div className="space-y-2">
          {staff.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center gap-2">
              <span className="w-40 truncate text-sm">{s.fullName}</span>
              <input
                className={`${inputClass} w-40`}
                dir="ltr"
                inputMode="numeric"
                value={wageInputs[s.id] ?? ""}
                onChange={(e) => setWageInputs((prev) => ({ ...prev, [s.id]: e.target.value }))}
                placeholder="حقوق ماهانه (تومان)"
              />
              <SecondaryButton onClick={() => saveWage(s.id)} disabled={busy}>
                ذخیره
              </SecondaryButton>
            </div>
          ))}
          {staff.length === 0 ? <p className="text-sm text-muted-foreground">عضو فعالی یافت نشد.</p> : null}
        </div>
      </section>

      <section className="rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="mb-3 font-semibold">تعهد حقوق و دستمزد جدید</h2>
        <form onSubmit={accrue} className="flex flex-wrap items-center gap-2">
          <input
            className={inputClass}
            value={periodLabel}
            onChange={(e) => setPeriodLabel(e.target.value)}
            placeholder="دوره (مثلاً مرداد ۱۴۰۴)"
            required
          />
          <div className="w-44">
            <JalaliDatePicker value={accrualDate} onChange={setAccrualDate} placeholder="تاریخ (امروز)" />
          </div>
          <PrimaryButton disabled={busy || !periodLabel.trim()}>ثبت تعهد</PrimaryButton>
        </form>
      </section>

      <section className="rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="mb-3 font-semibold">تاریخچه حقوق و دستمزد</h2>
        {runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">هنوز تعهدی ثبت نشده است.</p>
        ) : (
          <ul className="space-y-3">
            {runs.map((r) => (
              <li key={r.id} className="rounded-lg border border-border p-3 text-sm">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold">{r.periodLabel}</span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    {toPersianDigits(formatJalali(r.accrualDate))} — {formatToman(r.totalAmount)}
                    {r.status === "paid" ? (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                        پرداخت‌شده
                      </span>
                    ) : (
                      <span className="rounded-full bg-amber-500/10 px-2 py-0.5 font-semibold text-amber-700 dark:text-amber-400">
                        تعهدشده
                      </span>
                    )}
                  </span>
                </div>
                <table className="w-full">
                  <tbody>
                    {r.lines.map((l, i) => (
                      <tr key={i} className="border-t border-border">
                        <td className="py-1 pe-3 text-muted-foreground">{l.fullName ?? "—"}</td>
                        <td className="py-1">{formatToman(l.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {r.status === "accrued" ? (
                  <div className="mt-2">
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
