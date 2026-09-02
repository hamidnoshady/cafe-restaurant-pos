"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useState } from "react";
import { toLatinDigits } from "@/lib/digits";
import { ErrorBox, Field, InfoBox, PrimaryButton, api, errorMessage, inputClass } from "../ui";
import { SectionCard } from "../page-chrome";

interface Category {
  id: string;
  name: string;
  tax_rate: string | number;
}

interface TaxResponse {
  tax: { defaultRate: number } | null;
  categories: Category[];
  error?: string;
}

/** Default tax and per-category overrides. */
export function TaxSettings() {
  const [defaultRate, setDefaultRate] = useState("0");
  const [categories, setCategories] = useState<Category[]>([]);
  const [rates, setRates] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { ok, data } = await api<TaxResponse>("/api/settings/tax");
    if (ok) {
      setDefaultRate(String(data.tax?.defaultRate ?? 0));
      setCategories(data.categories);
      setRates(Object.fromEntries(data.categories.map((category) => [category.id, String(category.tax_rate)])));
      setError("");
    } else {
      setError(errorMessage(data.error));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function number(value: string): number | null {
    const parsed = Number(toLatinDigits(value).trim());
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const parsedDefault = number(defaultRate);
    const parsedCategories = categories.map((category) => ({ id: category.id, taxRate: number(rates[category.id] ?? "") }));
    if (parsedDefault === null || parsedCategories.some((category) => category.taxRate === null)) {
      setError("نرخ مالیات باید عددی بین ۰ تا ۱۰۰ باشد.");
      return;
    }
    setSaving(true);
    setError("");
    setSaved(false);
    const { ok, data } = await api<{ error?: string }>("/api/settings/tax", {
      method: "PUT",
      body: JSON.stringify({
        defaultRate: parsedDefault,
        categories: parsedCategories.map((category) => ({ id: category.id, taxRate: category.taxRate })),
      }),
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
      {saved ? <InfoBox>تنظیمات مالیات ذخیره شد.</InfoBox> : null}

      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">امور مالیاتی</p>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-stone-950 dark:text-stone-100">نرخ پیش‌فرض</h2>
          </div>
        }
        description="این نرخ هنگام ساخت دستهٔ جدید منو پیشنهاد می‌شود؛ نرخ هر دسته را می‌توانید جداگانه تغییر دهید."
      >
        <div className="max-w-xs">
          <Field label="درصد مالیات">
            <div className="relative">
              <PersianNumberInput className={inputClass} dir="ltr" inputMode="decimal" value={defaultRate} onChange={(e) => { setSaved(false); setDefaultRate(e.target.value); }} />
              <span className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-sm text-muted-foreground">٪</span>
            </div>
          </Field>
        </div>
      </SectionCard>

      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">دسته‌بندی منو</p>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-stone-950 dark:text-stone-100">نرخ دسته‌های منو</h2>
          </div>
        }
        description="برای کالاهای معاف یا دارای نرخ متفاوت، نرخ همین دسته را ویرایش کنید."
      >
        {categories.length === 0 ? <p className="text-sm text-muted-foreground">هنوز دسته‌ای در منو ثبت نشده است.</p> : null}
        <div className="space-y-2">
          {categories.map((category) => (
            <div key={category.id} className="flex items-center gap-3 rounded-lg border border-border/80 p-3">
              <span className="min-w-0 flex-1 text-sm font-medium">{category.name}</span>
              <div className="relative w-28">
                <PersianNumberInput className={inputClass} dir="ltr" inputMode="decimal" value={rates[category.id] ?? ""} onChange={(e) => { setSaved(false); setRates((current) => ({ ...current, [category.id]: e.target.value })); }} />
                <span className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-sm text-muted-foreground">٪</span>
              </div>
            </div>
          ))}
        </div>
      </SectionCard>

      <div className="max-w-xs">
        <PrimaryButton disabled={saving}>{saving ? "در حال ذخیره…" : "ذخیرهٔ مالیات"}</PrimaryButton>
      </div>
    </form>
  );
}
