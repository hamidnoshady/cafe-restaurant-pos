"use client";

import { LoadingSkeleton, SectionCard } from "@/app/dashboard/page-chrome";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useState } from "react";
import { toLatinDigits } from "@/lib/digits";
import {
  MAX_ONLINE_PLATFORM_COMMISSION_PERCENT,
  validCommissionPercent,
} from "@/lib/online-platforms";
import { Button } from "@/components/ui/button";
import { ErrorBox, Field, InfoBox, PrimaryButton, api, errorMessage, inputClass } from "@/app/dashboard/ui";

interface OnlinePlatformsResponse {
  onlinePlatforms?: { snappfood?: { commissionPercent?: number } | null };
  error?: string;
}

function parsePercentInput(raw: string): { ok: true; value: number | null } | { ok: false } {
  const trimmed = toLatinDigits(raw)
    .trim()
    .replace(/٫/g, ".")
    .replace(/[٬,]/g, "");
  if (trimmed === "") return { ok: true, value: null };
  const n = Number(trimmed);
  return validCommissionPercent(n) ? { ok: true, value: n } : { ok: false };
}

/**
 * SnapFood's contract commission. It is intentionally configured separately
 * from payment methods: the rate describes the platform contract, while the
 * payment-method settings decide which ways a cashier may offer at checkout.
 */
export function OnlinePlatformsSettings() {
  const [commissionPercent, setCommissionPercent] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    setError("");
    try {
      const { ok, data } = await api<OnlinePlatformsResponse>("/api/settings/online-platforms");
      if (!ok) {
        setLoadFailed(true);
        setError(errorMessage(data.error));
        return;
      }
      const commission = data.onlinePlatforms?.snappfood?.commissionPercent;
      setCommissionPercent(validCommissionPercent(commission) ? String(commission) : "");
      setSaved(false);
    } catch {
      // A network failure used to leave this screen with an empty field that
      // could overwrite the saved contract rate. Keep the form locked until a
      // complete read succeeds.
      setLoadFailed(true);
      setError("خواندن تنظیمات پلتفرم آنلاین انجام نشد. اتصال را بررسی و دوباره تلاش کنید.");
    } finally {
      setLoading(false);
    }
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
    try {
      const { ok, data } = await api<{ error?: string }>("/api/settings/online-platforms", {
        method: "PUT",
        body: JSON.stringify({ snappfoodCommissionPercent: commission.value }),
      });
      if (!ok) {
        setError(errorMessage(data.error));
        return;
      }
      setSaved(true);
    } catch {
      setError("ذخیرهٔ تنظیمات انجام نشد. اتصال را بررسی و دوباره تلاش کنید.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingSkeleton rows={4} />;

  if (loadFailed) {
    return (
      <div className="space-y-4">
        <ErrorBox>{error}</ErrorBox>
        <Button type="button" variant="outline" onClick={() => void load()}>
          تلاش دوباره
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={save} className="space-y-6">
      <ErrorBox>{error}</ErrorBox>
      {saved ? <InfoBox>تنظیمات پلتفرم آنلاین ذخیره شد.</InfoBox> : null}

      <SectionCard
        title="کارمزد اسنپ‌فود"
        description="این نرخ فقط برای سفارش‌هایی استفاده می‌شود که هنگام تسویه با روش پرداخت «اسنپ‌فود» ثبت می‌شوند. کارمزد از مبلغ فروش کسر می‌شود و مانده به‌عنوان مطالبات از اسنپ‌فود ثبت می‌شود؛ انعام، اگر وجود داشته باشد، مشمول کارمزد نیست."
      >
        <div className="max-w-sm">
          <Field
            label="درصد کارمزد قرارداد"
            hint="خالی بگذارید تا کارمزد صفر در نظر گرفته شود. مقدار ۱۰۰٪ هم برای قراردادهایی که کل مبلغ را کسر می‌کنند مجاز است."
          >
            <div className="relative">
              <PersianNumberInput
                className={`${inputClass} pe-9`}
                dir="ltr"
                inputMode="decimal"
                allowDecimal
                grouping={false}
                min={0}
                max={MAX_ONLINE_PLATFORM_COMMISSION_PERCENT}
                step="0.01"
                value={commissionPercent}
                onChange={(event) => {
                  setSaved(false);
                  setError("");
                  setCommissionPercent(event.target.value);
                }}
                placeholder="مثلاً ۲۲٫۵"
                aria-label="درصد کارمزد قرارداد اسنپ‌فود"
              />
              <span className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-sm text-muted-foreground" aria-hidden="true">
                ٪
              </span>
            </div>
          </Field>
        </div>

        <div className="mt-2 rounded-xl border border-amber-200/80 bg-amber-50/70 p-3 text-xs leading-6 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
          <p className="font-semibold">نحوهٔ استفاده</p>
          <p className="mt-1">
            برای اعمال این نرخ، روش پرداخت «اسنپ‌فود» باید در تنظیمات روش‌های پرداخت فعال باشد. این سامانه سفارش‌ها را از اسنپ‌فود به‌صورت خودکار دریافت نمی‌کند؛ سفارش را در صندوق ثبت و با همین روش تسویه کنید.
          </p>
        </div>
      </SectionCard>

      <div className="max-w-sm">
        <PrimaryButton disabled={saving}>{saving ? "در حال ذخیره…" : "ذخیرهٔ تنظیمات"}</PrimaryButton>
      </div>
    </form>
  );
}
