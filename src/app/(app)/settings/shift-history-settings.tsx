"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
/**
 * Phase 20 Wave 5 — admin review of every employee's shift history
 * (team.manage-gated, the same permission that lets an owner/manager reset
 * someone else's PIN — reviewing or force-closing a shift is the same kind
 * of "act on this employee's own security state" action). The self-service
 * clock-in/clock-out side is the sidebar's ShiftButton (shift-panel.tsx);
 * this tab never opens or ends a shift on the employee's behalf except when
 * force-closing one they left open.
 */
import { useCallback, useEffect, useState } from "react";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import { formatMoney, type MoneyUnit } from "@/lib/money";
import { useMoney } from "@/components/money/money-context";
import { ErrorBox, InfoBox, api, errorMessage, inputClass } from "@/app/dashboard/ui";
import { SectionCard } from "@/app/dashboard/page-chrome";
import { Button } from "@/components/ui/button";

interface Shift {
  id: string;
  employeeName: string;
  openingFloat: number | null;
  closingFloat: number | null;
  startedAt: string;
  endedAt: string | null;
  /** Phase 20 Wave 7 — computed by the server in the same query as the shift list itself; see shift-service.ts's listShifts. */
  reconciliation: { expectedCash: number; variance: number } | null;
}

function formatTime(iso: string | null): string {
  if (!iso) return "در حال انجام";
  return toPersianDigits(formatJalali(iso, { withMonthName: true, withTime: true }));
}

function formatFloat(value: number | null, unit: MoneyUnit = "toman"): string {
  return value === null ? "—" : toPersianDigits(formatMoney(value, unit));
}

function formatVariance(variance: number, unit: MoneyUnit = "toman"): string {
  const amount = toPersianDigits(formatMoney(Math.abs(variance), unit));
  if (variance === 0) return `بدون کسری/اضافه`;
  return variance > 0 ? `${amount} اضافه` : `${amount} کسری`;
}

export function ShiftHistorySettings() {
  const money = useMoney();
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [closingId, setClosingId] = useState<string | null>(null);
  const [closingAmount, setClosingAmount] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { ok, data } = await api<{ shifts: Shift[]; error?: string }>("/api/shifts");
    if (ok) {
      setShifts(data.shifts);
    } else {
      setError(errorMessage(data.error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function forceClose(id: string) {
    setBusy(true);
    setError("");
    setNotice("");
    let closingFloat: number | undefined;
    if (closingAmount.trim()) {
      try {
        closingFloat = money.parse(closingAmount);
      } catch {
        setBusy(false);
        setError(errorMessage("invalid_amount"));
        return;
      }
    }
    const { ok, data } = await api<{ error?: string }>(`/api/shifts/${id}/close`, {
      method: "POST",
      body: JSON.stringify({ closingFloat }),
    });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setNotice("شیفت با موفقیت بسته شد.");
    setClosingId(null);
    setClosingAmount("");
    await load();
  }

  return (
    <div className="space-y-6">
      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">عملکرد پرسنل</p>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-stone-950 dark:text-stone-100">شیفت‌ها</h2>
          </div>
        }
        description="تاریخچهٔ ورود/خروج کارکنان صندوق، گارسون و آشپزخانه. شیفت بازمانده (فراموش‌شده) را می‌توانید از همین‌جا ببندید."
      >
        <ErrorBox>{error}</ErrorBox>
        {notice ? <InfoBox>{notice}</InfoBox> : null}

        {shifts === null && <LoadingSkeleton rows={3} />}
        {shifts !== null && shifts.length === 0 && (
          <p className="text-sm text-muted-foreground">هنوز شیفتی ثبت نشده است.</p>
        )}
        {shifts !== null && shifts.length > 0 && (
          <div className="space-y-2">
            {shifts.map((shift) => (
              <div key={shift.id} className="rounded-lg border border-input px-3 py-2 text-sm">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">{shift.employeeName}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatTime(shift.startedAt)} تا {formatTime(shift.endedAt)}
                      {" · موجودی اول: "}
                      {formatFloat(shift.openingFloat, money.unit)}
                      {" · موجودی آخر: "}
                      {formatFloat(shift.closingFloat, money.unit)}
                      {shift.reconciliation ? ` · تطبیق: ${formatVariance(shift.reconciliation.variance, money.unit)}` : ""}
                    </p>
                  </div>
                  {!shift.endedAt && closingId !== shift.id && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setClosingId(shift.id)}
                    >
                      بستن شیفت
                    </Button>
                  )}
                </div>
                {closingId === shift.id && (
                  <div className="mt-2 flex items-center gap-2">
                    <PersianNumberInput
                      className={inputClass}
                      dir="ltr"
                      inputMode="numeric"
                      value={closingAmount}
                      onChange={(e) => setClosingAmount(e.target.value)}
                      placeholder="موجودی صندوق (اختیاری)"
                    />
                    <Button type="button" size="xs" onClick={() => forceClose(shift.id)} disabled={busy}>
                      تأیید
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => {
                        setClosingId(null);
                        setClosingAmount("");
                      }}
                    >
                      انصراف
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
