"use client";

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
import { formatToman, parseToRial } from "@/lib/money";
import { ErrorBox, InfoBox, api, errorMessage, inputClass } from "../ui";

interface Shift {
  id: string;
  employeeName: string;
  openingFloat: number | null;
  closingFloat: number | null;
  startedAt: string;
  endedAt: string | null;
}

function formatTime(iso: string | null): string {
  if (!iso) return "در حال انجام";
  return toPersianDigits(formatJalali(iso, { withMonthName: true }));
}

function formatFloat(value: number | null): string {
  return value === null ? "—" : toPersianDigits(formatToman(value));
}

export function ShiftHistorySettings() {
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
        closingFloat = parseToRial(closingAmount, "toman");
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
      <section className="rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="mb-1 font-semibold">شیفت‌ها</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          تاریخچهٔ ورود/خروج کارکنان صندوق، گارسون و آشپزخانه. شیفت بازمانده (فراموش‌شده) را می‌توانید از همین‌جا ببندید.
        </p>
        <ErrorBox>{error}</ErrorBox>
        {notice ? <InfoBox>{notice}</InfoBox> : null}

        {shifts === null && <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>}
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
                      {formatFloat(shift.openingFloat)}
                      {" · موجودی آخر: "}
                      {formatFloat(shift.closingFloat)}
                    </p>
                  </div>
                  {!shift.endedAt && closingId !== shift.id && (
                    <button
                      type="button"
                      onClick={() => setClosingId(shift.id)}
                      className="shrink-0 text-xs text-destructive hover:underline"
                    >
                      بستن شیفت
                    </button>
                  )}
                </div>
                {closingId === shift.id && (
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      className={inputClass}
                      dir="ltr"
                      inputMode="numeric"
                      value={closingAmount}
                      onChange={(e) => setClosingAmount(e.target.value)}
                      placeholder="موجودی صندوق (اختیاری)"
                    />
                    <button
                      type="button"
                      onClick={() => forceClose(shift.id)}
                      disabled={busy}
                      className="shrink-0 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition hover:bg-primary/85 disabled:opacity-50"
                    >
                      تأیید
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setClosingId(null);
                        setClosingAmount("");
                      }}
                      className="shrink-0 text-xs text-muted-foreground hover:underline"
                    >
                      انصراف
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
