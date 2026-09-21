"use client";

import Link from "next/link";
import { LoadingSkeleton, SectionCard } from "@/app/dashboard/page-chrome";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useState } from "react";
import { formatPersianNumericText, formatPersianNumber } from "@/lib/digits";
import {
  MAX_ONLINE_PLATFORM_COMMISSION_PERCENT,
  parseCommissionPercentInput,
  validCommissionPercent,
} from "@/lib/online-platforms";
import { commissionAmountFor } from "@/lib/online-platforms-calculation";
import type { RialText } from "@/lib/inventory-exact";
import { settingsTabHref } from "@/lib/settings-routes";
import { Button } from "@/components/ui/button";
import { ErrorBox, Field, InfoBox, PrimaryButton, api, errorMessage, inputClass } from "@/app/dashboard/ui";

interface OnlinePlatformsResponse {
  onlinePlatforms?: { snappfood?: { commissionPercent?: number } | null };
  paymentMethod?: { name?: string; isActive?: boolean } | null;
  error?: string;
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
  const [paymentMethod, setPaymentMethod] = useState<{ name: string; isActive: boolean } | null>(null);

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
      const config = data.onlinePlatforms;
      if (!config || !Object.prototype.hasOwnProperty.call(config, "snappfood")) {
        setLoadFailed(true);
        setError("پاسخ تنظیمات پلتفرم آنلاین ناقص است. دوباره تلاش کنید.");
        return;
      }
      const commission = config.snappfood?.commissionPercent;
      setCommissionPercent(validCommissionPercent(commission) ? String(commission) : "");
      const method = data.paymentMethod;
      setPaymentMethod(
        method
          ? { name: method.name?.trim() || "اسنپ‌فود", isActive: method.isActive === true }
          : null,
      );
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
    const commission = parseCommissionPercentInput(commissionPercent);
    if (!commission.ok) {
      setError("درصد کارمزد باید عددی بین ۰ تا ۱۰۰ باشد.");
      return;
    }
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const { ok, data } = await api<{ ok?: boolean; error?: string }>("/api/settings/online-platforms", {
        method: "PUT",
        body: JSON.stringify({ snappfoodCommissionPercent: commission.value }),
      });
      if (!ok) {
        setError(errorMessage(data.error));
        return;
      }
      if (data.ok !== true) {
        setError("پاسخ ذخیره‌سازی تنظیمات ناقص بود. دوباره تلاش کنید.");
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

  const parsedCommission = parseCommissionPercentInput(commissionPercent);
  const previewCommission =
    parsedCommission.ok && parsedCommission.value !== null
      ? commissionAmountFor("1000000" as RialText, parsedCommission.value)
      : null;
  const previewRate =
    parsedCommission.ok && parsedCommission.value !== null
      ? formatPersianNumericText(String(parsedCommission.value), { allowDecimal: true, grouping: false })
      : null;

  return (
    <form onSubmit={save} className="space-y-6" aria-busy={saving}>
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
                step="0.01"
                value={commissionPercent}
                disabled={saving}
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

        {previewCommission !== null && previewRate !== null ? (
          <div className="mt-2 rounded-xl border border-border/80 bg-muted/35 p-3 text-xs leading-6 text-muted-foreground" role="status" aria-live="polite">
            نمونهٔ محاسبه: از هر ۱٬۰۰۰٬۰۰۰ ریال فروش اسنپ‌فود با نرخ {previewRate}٪، مبلغ {formatPersianNumber(BigInt(previewCommission))} ریال به‌عنوان کارمزد کسر می‌شود.
          </div>
        ) : null}

        <div className="mt-2 rounded-xl border border-amber-200/80 bg-amber-50/70 p-3 text-xs leading-6 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold">وضعیت روش پرداخت «{paymentMethod?.name ?? "اسنپ‌فود"}»</p>
            <span
              className={
                paymentMethod?.isActive
                  ? "rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200"
                  : "rounded-full bg-amber-200/80 px-2 py-0.5 text-[11px] font-semibold text-amber-900 dark:bg-amber-500/20 dark:text-amber-100"
              }
            >
              {paymentMethod ? (paymentMethod.isActive ? "فعال" : "غیرفعال") : "پیدا نشد"}
            </span>
          </div>
          <p className="mt-1">
            {paymentMethod?.isActive
              ? "این نرخ هنگام تسویهٔ سفارش با همین روش پرداخت اعمال می‌شود. سامانه سفارش‌ها را از اسنپ‌فود به‌صورت خودکار دریافت نمی‌کند؛ سفارش را در صندوق ثبت و با همین روش تسویه کنید."
              : paymentMethod
                ? "روش پرداخت غیرفعال است و تا زمان فعال‌سازی، این نرخ در هیچ سفارش جدیدی اعمال نمی‌شود."
                : "روش پرداخت اسنپ‌فود در این کسب‌وکار پیدا نشد؛ تنظیمات روش‌های پرداخت را بررسی کنید."}
          </p>
          <Link
            href={settingsTabHref("payment-methods")}
            className="mt-2 inline-flex min-h-11 items-center rounded-lg font-semibold text-amber-800 underline decoration-amber-700/50 underline-offset-4 hover:text-amber-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600/50 dark:text-amber-200 dark:decoration-amber-300/50 dark:hover:text-amber-100"
          >
            مدیریت روش‌های پرداخت
          </Link>
        </div>
      </SectionCard>

      <div className="max-w-sm">
        <PrimaryButton disabled={saving}>{saving ? "در حال ذخیره…" : "ذخیرهٔ تنظیمات"}</PrimaryButton>
      </div>
    </form>
  );
}
