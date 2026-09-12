"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useState } from "react";
import { toLatinDigits } from "@/lib/digits";
import { ErrorBox, Field, InfoBox, PrimaryButton, api, errorMessage, inputClass } from "@/app/dashboard/ui";
import { SectionCard } from "@/app/dashboard/page-chrome";

interface OnlinePlatformsResponse {
  onlinePlatforms: { snappfood: { commissionPercent: number } | null };
  error?: string;
}

function parsePercentInput(raw: string): { ok: true; value: number | null } | { ok: false } {
  const trimmed = toLatinDigits(raw).trim();
  if (trimmed === "") return { ok: true, value: null };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0 || n >= 100) return { ok: false };
  return { ok: true, value: n };
}

/**
 * SnapFood's commission % (issue #160 §4) — varies by contract, so it's kept
 * here rather than hardcoded. Applied automatically to every order marked
 * "اسنپ‌فود" at checkout: /api/orders/[id]/pay resolves it to a Rial amount
 * and posts it to the platform-commission expense account, net of the
 * receivable from SnapFood.
 */
export function OnlinePlatformsSettings() {
  const [commissionPercent, setCommissionPercent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { ok, data } = await api<OnlinePlatformsResponse>("/api/settings/online-platforms");
    if (ok) {
      const commission = data.onlinePlatforms.snappfood?.commissionPercent;
      setCommissionPercent(commission != null ? String(commission) : "");
      setError("");
    } else {
      setError(errorMessage(data.error));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const commission = parsePercentInput(commissionPercent);
    if (!commission.ok) {
      setError("درصد کارمزد باید عددی بین ۰ تا ۱۰۰ باشد.");
      return;
    }
    setSaving(true);
    setError("");
    setSaved(false);
    const { ok, data } = await api<{ error?: string }>("/api/settings/online-platforms", {
      method: "PUT",
      body: JSON.stringify({ snappfoodCommissionPercent: commission.value }),
    });
    setSaving(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setSaved(true);
  }

  if (loading) return <LoadingSkeleton rows={3} />;

  return (
    <form onSubmit={save} className="space-y-6">
      <ErrorBox>{error}</ErrorBox>
      {saved ? <InfoBox>تنظیمات پلتفرم آنلاین ذخیره شد.</InfoBox> : null}

      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">پلتفرم‌های آنلاین</p>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-stone-950 dark:text-stone-100">کارمزد اسنپ‌فود</h2>
          </div>
        }
        description="این درصد از مبلغ هر سفارشی که هنگام تسویه با روش «اسنپ‌فود» ثبت می‌شود کسر و به‌عنوان هزینهٔ کارمزد پلتفرم ثبت می‌شود؛ باقیمانده به‌عنوان مطالبات از اسنپ‌فود ثبت می‌شود تا زمانی که تسویه واقعی دریافت شود. چون این نرخ بر اساس قرارداد هر کسب‌وکار متفاوت است، اینجا تنظیم می‌شود، نه در کد. خالی بگذارید تا بدون کسر کارمزدی، کل مبلغ به‌عنوان مطالبات ثبت شود."
      >
        <div className="max-w-xs">
          <Field label="درصد کارمزد">
            <div className="relative">
              <PersianNumberInput
                className={inputClass}
                dir="ltr"
                inputMode="decimal"
                value={commissionPercent}
                onChange={(e) => {
                  setSaved(false);
                  setCommissionPercent(e.target.value);
                }}
                placeholder="مثلاً ۲۲.۵"
              />
              <span className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-sm text-muted-foreground">٪</span>
            </div>
          </Field>
        </div>
      </SectionCard>

      <div className="max-w-xs">
        <PrimaryButton disabled={saving}>{saving ? "در حال ذخیره…" : "ذخیرهٔ تنظیمات"}</PrimaryButton>
      </div>
    </form>
  );
}
