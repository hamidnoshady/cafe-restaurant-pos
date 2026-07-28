"use client";

import { useCallback, useEffect, useState } from "react";
import { toLatinDigits } from "@/lib/digits";
import { ErrorBox, Field, InfoBox, PrimaryButton, api, errorMessage, inputClass } from "../ui";

interface PricingResponse {
  pricing: { defaultMarginPercent: number | null };
  error?: string;
}

/** Business-wide default target gross margin for cost-plus pricing suggestions on menu items. */
export function PricingSettings() {
  const [defaultMarginPercent, setDefaultMarginPercent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { ok, data } = await api<PricingResponse>("/api/settings/pricing");
    if (ok) {
      setDefaultMarginPercent(data.pricing.defaultMarginPercent != null ? String(data.pricing.defaultMarginPercent) : "");
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
    const trimmed = toLatinDigits(defaultMarginPercent).trim();
    let value: number | null;
    if (trimmed === "") {
      value = null;
    } else {
      value = Number(trimmed);
      if (!Number.isFinite(value) || value < 0 || value >= 100) {
        setError("درصد حاشیه سود باید عددی بین ۰ تا ۱۰۰ باشد.");
        return;
      }
    }
    setSaving(true);
    setError("");
    setSaved(false);
    const { ok, data } = await api<{ error?: string }>("/api/settings/pricing", {
      method: "PUT",
      body: JSON.stringify({ defaultMarginPercent: value }),
    });
    setSaving(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setSaved(true);
  }

  if (loading) return <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>;

  return (
    <form onSubmit={save} className="space-y-6">
      <ErrorBox>{error}</ErrorBox>
      {saved ? <InfoBox>تنظیمات قیمت‌گذاری ذخیره شد.</InfoBox> : null}

      <section className="rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="mb-1 font-semibold">هدف حاشیه سود پیش‌فرض</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          این درصد برای پیشنهاد قیمت هر آیتم منو استفاده می‌شود (بهای مواد + سربار عملیاتی، تقسیم بر باقیمانده پس از این
          حاشیه سود از قیمت فروش) مگر آنکه آن آیتم مقدار اختصاصی خودش را داشته باشد. خالی بگذارید تا تا زمان تعیین این
          عدد، قیمتی پیشنهاد نشود.
        </p>
        <div className="max-w-xs">
          <Field label="درصد حاشیه سود">
            <div className="relative">
              <input
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
      </section>

      <div className="max-w-xs">
        <PrimaryButton disabled={saving}>{saving ? "در حال ذخیره…" : "ذخیرهٔ قیمت‌گذاری"}</PrimaryButton>
      </div>
    </form>
  );
}
