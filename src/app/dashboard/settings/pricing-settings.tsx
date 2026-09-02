"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useState } from "react";
import { toLatinDigits } from "@/lib/digits";
import { ErrorBox, Field, InfoBox, PrimaryButton, api, errorMessage, inputClass } from "../ui";
import { SectionCard } from "../page-chrome";

interface PricingResponse {
  pricing: { defaultMarginPercent: number | null; fallbackOverheadPercent: number | null };
  error?: string;
}

/** Parses a percent input; empty string means "clear it" (null), anything else must be a finite number below `max`. */
function parsePercentInput(raw: string, max: number): { ok: true; value: number | null } | { ok: false } {
  const trimmed = toLatinDigits(raw).trim();
  if (trimmed === "") return { ok: true, value: null };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0 || n >= max) return { ok: false };
  return { ok: true, value: n };
}

/** Business-wide default target gross margin and fallback overhead % for cost-plus pricing suggestions on menu items. */
export function PricingSettings() {
  const [defaultMarginPercent, setDefaultMarginPercent] = useState("");
  const [fallbackOverheadPercent, setFallbackOverheadPercent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { ok, data } = await api<PricingResponse>("/api/settings/pricing");
    if (ok) {
      setDefaultMarginPercent(data.pricing.defaultMarginPercent != null ? String(data.pricing.defaultMarginPercent) : "");
      setFallbackOverheadPercent(
        data.pricing.fallbackOverheadPercent != null ? String(data.pricing.fallbackOverheadPercent) : "",
      );
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
    const margin = parsePercentInput(defaultMarginPercent, 100);
    if (!margin.ok) {
      setError("درصد حاشیه سود باید عددی بین ۰ تا ۱۰۰ باشد.");
      return;
    }
    const overhead = parsePercentInput(fallbackOverheadPercent, 1000);
    if (!overhead.ok) {
      setError("درصد سربار برآوردی باید عددی بین ۰ تا ۱۰۰۰ باشد.");
      return;
    }
    setSaving(true);
    setError("");
    setSaved(false);
    const { ok, data } = await api<{ error?: string }>("/api/settings/pricing", {
      method: "PUT",
      body: JSON.stringify({ defaultMarginPercent: margin.value, fallbackOverheadPercent: overhead.value }),
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
      {saved ? <InfoBox>تنظیمات قیمت‌گذاری ذخیره شد.</InfoBox> : null}

      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سیاست‌گذاری قیمت</p>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-stone-950 dark:text-stone-100">هدف حاشیه سود پیش‌فرض</h2>
          </div>
        }
        description="این درصد برای پیشنهاد قیمت هر آیتم منو استفاده می‌شود (بهای مواد + سربار عملیاتی، تقسیم بر باقیمانده پس از این حاشیه سود از قیمت فروش) مگر آنکه آن آیتم مقدار اختصاصی خودش را داشته باشد. خالی بگذارید تا تا زمان تعیین این عدد، قیمتی پیشنهاد نشود."
      >
        <div className="max-w-xs">
          <Field label="درصد حاشیه سود">
            <div className="relative">
              <PersianNumberInput
                className={inputClass}
                dir="ltr"
                inputMode="decimal"
                value={defaultMarginPercent}
                onChange={(e) => {
                  setSaved(false);
                  setDefaultMarginPercent(e.target.value);
                }}
                placeholder="مثلاً ۳۰"
              />
              <span className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-sm text-muted-foreground">٪</span>
            </div>
          </Field>
        </div>
      </SectionCard>

      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سربار کسب‌وکار</p>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-stone-950 dark:text-stone-100">سربار برآوردی برای کسب‌وکار تازه</h2>
          </div>
        }
        description="سربار (اجاره، آب و برق، حقوق) در حالت عادی خودکار و از روی ۳۰ روز اخیر دفتر حسابداری محاسبه می‌شود. تا وقتی فروش کافی برای این محاسبه ثبت نشده — مثلاً در روزهای اول کسب‌وکار — این عدد به‌جای آن استفاده می‌شود. به‌محض آنکه محاسبهٔ خودکار ممکن شود، این مقدار نادیده گرفته می‌شود."
      >
        <div className="max-w-xs">
          <Field label="درصد سربار برآوردی">
            <div className="relative">
              <PersianNumberInput
                className={inputClass}
                dir="ltr"
                inputMode="decimal"
                value={fallbackOverheadPercent}
                onChange={(e) => {
                  setSaved(false);
                  setFallbackOverheadPercent(e.target.value);
                }}
                placeholder="مثلاً ۳۵"
              />
              <span className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-sm text-muted-foreground">٪</span>
            </div>
          </Field>
        </div>
      </SectionCard>

      <div className="max-w-xs">
        <PrimaryButton disabled={saving}>{saving ? "در حال ذخیره…" : "ذخیرهٔ قیمت‌گذاری"}</PrimaryButton>
      </div>
    </form>
  );
}
