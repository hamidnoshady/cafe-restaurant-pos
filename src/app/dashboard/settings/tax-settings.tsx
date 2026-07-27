"use client";

import { useCallback, useEffect, useState } from "react";
import { toLatinDigits } from "@/lib/digits";
import { ErrorBox, Field, InfoBox, PrimaryButton, api, errorMessage, inputClass } from "../ui";

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

  if (loading) return <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>;

  return (
    <form onSubmit={save} className="space-y-6">
      <ErrorBox>{error}</ErrorBox>
      {saved ? <InfoBox>تنظیمات مالیات ذخیره شد.</InfoBox> : null}

      <section className="rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="mb-1 font-semibold">نرخ پیش‌فرض</h2>
        <p className="mb-4 text-sm text-muted-foreground">این نرخ هنگام ساخت دستهٔ جدید منو پیشنهاد می‌شود؛ نرخ هر دسته را می‌توانید جداگانه تغییر دهید.</p>
        <div className="max-w-xs">
          <Field label="درصد مالیات">
            <div className="relative">
              <input className={inputClass} dir="ltr" inputMode="decimal" value={defaultRate} onChange={(e) => { setSaved(false); setDefaultRate(e.target.value); }} />
              <span className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-sm text-muted-foreground">٪</span>
            </div>
          </Field>
        </div>
      </section>

      <section className="rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="mb-1 font-semibold">نرخ دسته‌های منو</h2>
        <p className="mb-4 text-sm text-muted-foreground">برای کالاهای معاف یا دارای نرخ متفاوت، نرخ همین دسته را ویرایش کنید.</p>
        {categories.length === 0 ? <p className="text-sm text-muted-foreground">هنوز دسته‌ای در منو ثبت نشده است.</p> : null}
        <div className="space-y-2">
          {categories.map((category) => (
            <div key={category.id} className="flex items-center gap-3 rounded-lg border border-border p-3">
              <span className="min-w-0 flex-1 text-sm font-medium">{category.name}</span>
              <div className="relative w-28">
                <input className={inputClass} dir="ltr" inputMode="decimal" value={rates[category.id] ?? ""} onChange={(e) => { setSaved(false); setRates((current) => ({ ...current, [category.id]: e.target.value })); }} />
                <span className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-sm text-muted-foreground">٪</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="max-w-xs">
        <PrimaryButton disabled={saving}>{saving ? "در حال ذخیره…" : "ذخیرهٔ مالیات"}</PrimaryButton>
      </div>
    </form>
  );
}
