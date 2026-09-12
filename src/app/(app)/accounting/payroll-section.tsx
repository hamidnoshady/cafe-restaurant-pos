"use client";

import { SectionCardSkeleton } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { api, errorMessage, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import type { Runner } from "./accounting-manager";
import { cardClass } from "@/app/dashboard/page-chrome";

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
  /*
   * «پرداخت از» — the account the payout leaves.
   *
   * `POST /api/ledger/payroll/runs/:id/pay` has accepted `cash` or `bank` since
   * this feature shipped, and the payment posts against whichever is chosen.
   * The button hardcoded `cash` and said «پرداخت (از صندوق)», so a business
   * paying wages by transfer had to either post it from the till or write the
   * entry by hand.
   */
  const [payMethod, setPayMethod] = useState<Record<string, "cash" | "bank">>({});

  function load() {
    api<{ staff: StaffWage[] }>("/api/ledger/payroll/staff").then(({ ok, data }) => {
      if (ok) {
        setStaff(data.staff);
        setWageInputs(
          Object.fromEntries(data.staff.map((s) => [s.id, s.monthlyWage != null ? String(money.toInput(s.monthlyWage)) : ""])),
        );
      } else {
        // An endless skeleton reads as "still loading"; name the failure.
        setStaff([]);
        setLocalError("بارگذاری فهرست کارکنان ناموفق بود.");
      }
    });
    api<{ runs: PayrollRun[] }>("/api/ledger/payroll/runs").then(({ ok, data }) => {
      if (ok) setRuns(data.runs);
      else {
        setRuns([]);
        setLocalError("بارگذاری تاریخچه حقوق ناموفق بود.");
      }
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
    const method = payMethod[runId] ?? "cash";
    await run(() => api("/api/ledger/payroll/runs/" + runId + "/pay", { method: "POST", body: JSON.stringify({ method }) }));
  }

  if (!staff || !runs) {
    return (
      <SectionCardSkeleton rows={4} />
    );
  }

  return (
    <div className="space-y-5">
      <section aria-labelledby="payroll-wages-heading" className={cardClass}>
        <header className="border-b border-border/80 px-4 py-4 sm:px-5">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">تنظیمات حقوق</p>
          <h2 id="payroll-wages-heading" className="mt-1 text-base font-semibold text-foreground">حقوق ماهانه کارکنان</h2>
          {/* The unit is the business's own choice (ریال/تومان), so it comes from
              the money context rather than being asserted in the copy. */}
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            مبلغ حقوق هر کارمند را به {money.unitLabel} وارد و ذخیره کنید.
          </p>
        </header>

        <div className="p-4 sm:p-5">
        {localError ? (
          <p role="alert" className="mb-4 rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {localError}
          </p>
        ) : null}

        {staff.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            عضو فعالی یافت نشد.
          </p>
        ) : (
          <div className="space-y-3">
            {staff.map((s) => (
              <div key={s.id} className="grid gap-3 rounded-xl border border-border/80 bg-stone-50/60 p-4 dark:bg-stone-800/30 md:grid-cols-[minmax(10rem,1fr)_minmax(12rem,15rem)_auto] md:items-end">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">کارمند</p>
                  <p className="mt-1 font-semibold text-foreground">{s.fullName}</p>
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
        </div>
      </section>

      <section aria-labelledby="payroll-accrual-heading" className={cardClass}>
        <header className="border-b border-border/80 px-4 py-4 sm:px-5">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">ثبت دوره</p>
          <h2 id="payroll-accrual-heading" className="mt-1 text-base font-semibold text-foreground">تعهد حقوق و دستمزد جدید</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">ثبت تعهد، همان گردش سندداری موجود را اجرا می‌کند.</p>
        </header>
        <form onSubmit={accrue} className="grid gap-4 p-4 sm:p-5 md:grid-cols-[minmax(14rem,1fr)_12rem_auto] md:items-end">
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

      <section aria-labelledby="payroll-history-heading" className={cardClass}>
        <header className="border-b border-border/80 px-4 py-4 sm:px-5">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سوابق</p>
          <h2 id="payroll-history-heading" className="mt-1 text-base font-semibold text-foreground">تاریخچه حقوق و دستمزد</h2>
        </header>

        <div className="p-4 sm:p-5">
        {runs.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            هنوز تعهدی ثبت نشده است.
          </p>
        ) : (
          <ul className="space-y-3">
            {runs.map((r) => (
              <li key={r.id} className="rounded-xl border border-border/80 bg-stone-50/60 p-4 dark:bg-stone-800/30">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
                  <div>
                    <h3 className="font-semibold text-foreground">{r.periodLabel}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">{toPersianDigits(formatJalali(r.accrualDate))}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold tabular-nums text-foreground">{money.format(r.totalAmount)}</span>
                    <span className={"rounded-full px-2.5 py-1 text-xs font-semibold " + (r.status === "paid" ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-200" : "bg-amber-100 text-amber-950 dark:bg-amber-500/20 dark:text-amber-200")}>
                      {r.status === "paid" ? "پرداخت‌شده" : "تعهدشده"}
                    </span>
                  </div>
                </div>

                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {r.lines.map((l, i) => (
                    <div key={i} className="flex items-center justify-between gap-3 rounded-lg bg-stone-50 px-3 py-2.5 text-sm dark:bg-stone-800/40">
                      <span className="min-w-0 truncate text-muted-foreground">{l.fullName ?? "—"}</span>
                      <span className="shrink-0 font-semibold tabular-nums text-foreground">{money.format(l.amount)}</span>
                    </div>
                  ))}
                </div>

                {r.status === "accrued" ? (
                  <div className="mt-4 grid gap-3 border-t border-border pt-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,14rem)] sm:items-end">
                    <label className="block text-sm font-medium">
                      <span className="mb-1.5 block text-xs text-muted-foreground">پرداخت از</span>
                      <SearchableSelect
                        value={payMethod[r.id] ?? "cash"}
                        onChange={(value) => setPayMethod((prev) => ({ ...prev, [r.id]: value as "cash" | "bank" }))}
                        ariaLabel={`حساب پرداخت حقوق دوره ${r.periodLabel}`}
                        options={[
                          { value: "cash", label: "صندوق (نقدی)" },
                          { value: "bank", label: "بانکی" },
                        ]}
                      />
                    </label>
                    <SecondaryButton onClick={() => pay(r.id)} disabled={busy}>
                      ثبت پرداخت حقوق
                    </SecondaryButton>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        </div>
      </section>
    </div>
  );
}
