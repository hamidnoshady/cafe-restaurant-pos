"use client";

import { SectionCardSkeleton } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useEffect, useMemo, useState } from "react";
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

type PayrollRunStatus = "accrued" | "paid" | "voided";

interface PayrollRun {
  id: string;
  periodLabel: string;
  status: PayrollRunStatus;
  totalAmount: number;
  accrualDate: string;
  paidDate: string | null;
  voidedDate: string | null;
  createdByName: string | null;
  lines: PayrollRunLine[];
}

// The team roles a staff member can hold, in the platform's own Persian. Kept
// here (not imported from the sidebar) so this section owns the labels it shows;
// an unknown role falls back to its raw key rather than a blank.
const ROLE_LABELS: Record<string, string> = {
  owner: "مالک",
  manager: "مدیر",
  accountant: "حسابدار",
  cashier: "صندوق‌دار",
  waiter: "گارسون",
  kitchen: "آشپزخانه",
};

function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

const STATUS_STYLES: Record<PayrollRunStatus, { label: string; className: string }> = {
  paid: {
    label: "پرداخت‌شده",
    className: "bg-emerald-100 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-200",
  },
  accrued: {
    label: "تعهدشده",
    className: "bg-amber-100 text-amber-950 dark:bg-amber-500/20 dark:text-amber-200",
  },
  voided: {
    label: "ابطال‌شده",
    className: "bg-stone-200 text-stone-600 line-through dark:bg-stone-700/40 dark:text-stone-300",
  },
};

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
  const [savingWage, setSavingWage] = useState<string | null>(null);
  const [periodLabel, setPeriodLabel] = useState("");
  const [accrualDate, setAccrualDate] = useState("");
  const [localError, setLocalError] = useState("");
  const [localNotice, setLocalNotice] = useState("");
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

  // The staff who will actually be accrued: an active member with a positive
  // wage set. This mirrors accruePayroll's own WHERE clause, so the preview and
  // the total match exactly what a «ثبت تعهد» will post.
  const payableStaff = useMemo(() => (staff ?? []).filter((s) => s.monthlyWage != null && s.monthlyWage > 0), [staff]);
  const monthlyWageBill = useMemo(() => payableStaff.reduce((sum, s) => sum + (s.monthlyWage ?? 0), 0), [payableStaff]);

  async function saveWage(userId: string) {
    setLocalError("");
    setLocalNotice("");
    const raw = wageInputs[userId] ?? "";
    let rial: number | null = null;
    if (raw.trim()) {
      try {
        rial = money.parse(raw);
      } catch {
        return setLocalError("مبلغ حقوق معتبر نیست.");
      }
    }
    setSavingWage(userId);
    const { ok, data } = await api("/api/ledger/payroll/staff/" + userId, {
      method: "PATCH",
      body: JSON.stringify({ monthlyWage: rial }),
    });
    setSavingWage(null);
    if (!ok) return setLocalError(errorMessage((data as { error?: string }).error));
    setLocalNotice("حقوق ذخیره شد.");
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

  async function voidRun(r: PayrollRun) {
    const question =
      r.status === "paid"
        ? `ابطال «${r.periodLabel}»؟ هم سند تعهد و هم سند پرداخت با اسناد معکوس (به تاریخ امروز) برگشت می‌خورند.`
        : `ابطال «${r.periodLabel}»؟ سند تعهد با یک سند معکوس (به تاریخ امروز) برگشت می‌خورد.`;
    if (!window.confirm(question)) return;
    await run(() => api("/api/ledger/payroll/runs/" + r.id + "/void", { method: "POST" }));
  }

  if (!staff || !runs) {
    return (
      <SectionCardSkeleton rows={4} />
    );
  }

  return (
    <div className="space-y-5">
      {localError ? (
        <p role="alert" className="rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {localError}
        </p>
      ) : null}
      {localNotice ? (
        <p role="status" className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          {localNotice}
        </p>
      ) : null}

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
        {staff.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            عضو فعالی یافت نشد.
          </p>
        ) : (
          <>
          <div className="space-y-3">
            {staff.map((s) => (
              <div key={s.id} className="grid gap-3 rounded-xl border border-border/80 bg-stone-50/60 p-4 dark:bg-stone-800/30 md:grid-cols-[minmax(10rem,1fr)_minmax(12rem,15rem)_auto] md:items-end">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">کارمند</p>
                  <p className="mt-1 font-semibold text-foreground">{s.fullName}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{roleLabel(s.role)}</p>
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
                  <SecondaryButton onClick={() => saveWage(s.id)} disabled={busy || savingWage === s.id}>
                    {savingWage === s.id ? "در حال ذخیره…" : "ذخیره"}
                  </SecondaryButton>
                </div>
              </div>
            ))}
          </div>

          {/* The month's wage bill at a glance: how many people carry a wage, and
              the sum a «ثبت تعهد» would post today. */}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/20 bg-amber-50/60 px-4 py-3 dark:bg-amber-500/10">
            <span className="text-sm text-muted-foreground">
              {toPersianDigits(payableStaff.length)} نفر از {toPersianDigits(staff.length)} کارمند حقوق تعیین‌شده دارند
            </span>
            <span className="text-sm font-semibold tabular-nums text-foreground">
              جمع حقوق ماهانه: {money.format(monthlyWageBill)}
            </span>
          </div>
          </>
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
            <PrimaryButton disabled={busy || !periodLabel.trim() || payableStaff.length === 0}>ثبت تعهد</PrimaryButton>
          </div>
          {/* A preview of exactly what the accrual will post — the payable staff
              and the total — so «ثبت تعهد» never surprises. */}
          <div className="md:col-span-3">
            {payableStaff.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
                هیچ کارمندی حقوق تعیین‌شده ندارد؛ ابتدا در بخش بالا حقوق ماهانه را وارد کنید.
              </p>
            ) : (
              <div className="rounded-xl border border-border/80 bg-stone-50/60 p-4 dark:bg-stone-800/30">
                <div className="flex items-center justify-between gap-3 border-b border-border pb-2">
                  <span className="text-xs font-medium text-muted-foreground">این تعهد ثبت خواهد شد</span>
                  <span className="text-sm font-semibold tabular-nums text-foreground">{money.format(monthlyWageBill)}</span>
                </div>
                <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
                  {payableStaff.map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-3 text-sm">
                      <span className="min-w-0 truncate text-muted-foreground">{s.fullName}</span>
                      <span className="shrink-0 tabular-nums text-foreground">{money.format(s.monthlyWage ?? 0)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
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
            {runs.map((r) => {
              const status = STATUS_STYLES[r.status];
              return (
              <li key={r.id} className="rounded-xl border border-border/80 bg-stone-50/60 p-4 dark:bg-stone-800/30">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
                  <div>
                    <h3 className="font-semibold text-foreground">{r.periodLabel}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      تاریخ تعهد: {toPersianDigits(formatJalali(r.accrualDate))}
                      {r.status === "paid" && r.paidDate
                        ? ` — پرداخت: ${toPersianDigits(formatJalali(r.paidDate))}`
                        : ""}
                      {r.status === "voided" && r.voidedDate
                        ? ` — ابطال: ${toPersianDigits(formatJalali(r.voidedDate))}`
                        : ""}
                    </p>
                    {r.createdByName ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">ثبت توسط: {r.createdByName}</p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={"font-bold tabular-nums " + (r.status === "voided" ? "text-muted-foreground line-through" : "text-foreground")}>
                      {money.format(r.totalAmount)}
                    </span>
                    <span className={"rounded-full px-2.5 py-1 text-xs font-semibold " + status.className}>
                      {status.label}
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
                  <div className="mt-4 grid gap-3 border-t border-border pt-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,14rem)_auto] sm:items-end">
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
                    <button
                      type="button"
                      onClick={() => voidRun(r)}
                      disabled={busy}
                      className="h-10 rounded-lg px-3 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
                    >
                      ابطال تعهد
                    </button>
                  </div>
                ) : null}

                {r.status === "paid" ? (
                  <div className="mt-4 flex justify-end border-t border-border pt-3">
                    <button
                      type="button"
                      onClick={() => voidRun(r)}
                      disabled={busy}
                      className="h-10 rounded-lg px-3 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
                    >
                      ابطال (برگشت تعهد و پرداخت)
                    </button>
                  </div>
                ) : null}
              </li>
              );
            })}
          </ul>
        )}
        </div>
      </section>
    </div>
  );
}
