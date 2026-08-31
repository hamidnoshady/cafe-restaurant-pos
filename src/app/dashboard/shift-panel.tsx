"use client";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
/**
 * Phase 20 Wave 5 — self-service clock-in/clock-out for PIN-role staff (the
 * same audience as the lock screen and biometric-settings panel), in the
 * sidebar footer next to them rather than under /dashboard/settings for the
 * same reason biometric-settings.tsx lives there: this is each employee
 * managing their own shift, not something a manager configures for them.
 * The admin review side (shift history, force-close) is the separate
 * "شیفت‌ها" settings tab (shift-history-settings.tsx).
 */
import { useCallback, useEffect, useState } from "react";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { ErrorBox, Field, InfoBox, PrimaryButton, api, errorMessage, inputClass } from "./ui";
import { Skeleton } from "@/components/ui/skeleton";
import { overlayPanelClass } from "./page-chrome";

interface Shift {
  id: string;
  openingFloat: number | null;
  closingFloat: number | null;
  startedAt: string;
  endedAt: string | null;
}

interface CashSummary {
  orderCount: number;
  cashTotal: number;
}

interface ActiveShiftResponse {
  shift: Shift | null;
  cashSummary?: CashSummary;
  error?: string;
}

export function ShiftButton() {
  const [open, setOpen] = useState(false);
  const [shift, setShift] = useState<Shift | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const { ok, data } = await api<ActiveShiftResponse>("/api/shifts/active");
      if (ok) setShift(data.shift);
    } catch {
      // Leave the action available; opening it will surface any request error.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!loaded) {
    return (
      <div role="status" aria-live="polite" aria-busy="true" aria-label="در حال بارگذاری وضعیت شیفت">
        <Skeleton aria-hidden="true" className="mb-2 h-8 w-full rounded-lg" />
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          "mb-2 w-full rounded-lg border py-1.5 text-sm transition " +
          (shift
            ? "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15"
            : "border-input text-muted-foreground hover:bg-muted/50")
        }
      >
        {shift ? "پایان شیفت" : "شروع شیفت"}
      </button>
      {open && (
        <ShiftModal
          shift={shift}
          onClose={() => setOpen(false)}
          onChanged={async () => {
            await load();
          }}
        />
      )}
    </>
  );
}

function ShiftModal({
  shift,
  onClose,
  onChanged,
}: {
  shift: Shift | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const money = useMoney();
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ variance: number } | null>(null);

  async function start() {
    setBusy(true);
    setError("");
    let openingFloat: number | undefined;
    if (amount.trim()) {
      try {
        openingFloat = money.parse(amount);
      } catch {
        setBusy(false);
        setError(errorMessage("invalid_amount"));
        return;
      }
    }
    const { ok, data } = await api<{ error?: string }>("/api/shifts/start", {
      method: "POST",
      body: JSON.stringify({ openingFloat }),
    });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    await onChanged();
    onClose();
  }

  async function end() {
    setBusy(true);
    setError("");
    let closingFloat: number | undefined;
    if (amount.trim()) {
      try {
        closingFloat = money.parse(amount);
      } catch {
        setBusy(false);
        setError(errorMessage("invalid_amount"));
        return;
      }
    }
    const { ok, data } = await api<{ error?: string; reconciliation?: { variance: number } | null }>(
      "/api/shifts/end",
      { method: "POST", body: JSON.stringify({ closingFloat }) },
    );
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    await onChanged();
    if (data.reconciliation) {
      setResult(data.reconciliation);
    } else {
      onClose();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 p-4 backdrop-blur-sm">
      <div className={`${overlayPanelClass} w-full max-w-sm p-6`}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">{shift ? "پایان شیفت" : "شروع شیفت"}</h2>
          <button type="button" onClick={onClose} className="text-sm text-muted-foreground hover:text-foreground">
            بستن
          </button>
        </div>

        {result ? (
          <InfoBox>
            شیفت پایان یافت. اختلاف صندوق:{" "}
            {result.variance === 0
              ? "بدون اختلاف"
              : `${result.variance > 0 ? "+" : ""}${money.format(result.variance)}`}
          </InfoBox>
        ) : (
          <>
            {shift && (
              <p className="mb-3 text-xs text-muted-foreground">
                شروع شیفت: {toPersianDigits(formatJalali(shift.startedAt, { withMonthName: true, withTime: true }))}
                {shift.openingFloat !== null
                  ? ` · موجودی اول: ${money.format(shift.openingFloat)}`
                  : ""}
              </p>
            )}
            <ErrorBox>{error}</ErrorBox>
            <Field
              label={shift ? "موجودی صندوق در پایان (اختیاری)" : "موجودی اول صندوق (اختیاری)"}
              hint="برای شیفت‌های بدون صندوق (گارسون/آشپزخانه) می‌توانید خالی بگذارید."
            >
              <PersianNumberInput
                className={inputClass}
                dir="ltr"
                inputMode="numeric"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="۰"
              />
            </Field>
            <PrimaryButton type="button" disabled={busy} onClick={shift ? end : start}>
              {busy ? "در حال ثبت…" : shift ? "پایان شیفت" : "شروع شیفت"}
            </PrimaryButton>
          </>
        )}
      </div>
    </div>
  );
}
