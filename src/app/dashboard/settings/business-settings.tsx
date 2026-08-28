"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorBox, Field, InfoBox, api, errorMessage, inputClass } from "../ui";
import { SectionCard } from "../page-chrome";

interface BusinessState {
  business: { name: string } | null;
  location: { name: string; address: string | null; phone: string | null } | null;
  prefs: { currencyDisplay?: "toman" | "rial" } | null;
  profile: {
    legalName?: string;
    taxId?: string;
    email?: string;
    website?: string;
    receiptFooter?: string;
  } | null;
  error?: string;
}

interface FormState {
  businessName: string;
  locationName: string;
  address: string;
  phone: string;
  currencyDisplay: "toman" | "rial";
  legalName: string;
  taxId: string;
  email: string;
  website: string;
  receiptFooter: string;
}

const EMPTY: FormState = {
  businessName: "",
  locationName: "",
  address: "",
  phone: "",
  currencyDisplay: "toman",
  legalName: "",
  taxId: "",
  email: "",
  website: "",
  receiptFooter: "",
};

function fromState(data: BusinessState): FormState {
  return {
    businessName: data.business?.name ?? "",
    locationName: data.location?.name ?? "",
    address: data.location?.address ?? "",
    phone: data.location?.phone ?? "",
    currencyDisplay: data.prefs?.currencyDisplay === "rial" ? "rial" : "toman",
    legalName: data.profile?.legalName ?? "",
    taxId: data.profile?.taxId ?? "",
    email: data.profile?.email ?? "",
    website: data.profile?.website ?? "",
    receiptFooter: data.profile?.receiptFooter ?? "",
  };
}

/**
 * Two options are a pair of buttons, not a dropdown — the choice is visible
 * without opening anything, and «تومان»/«ریال» is the setting most often
 * checked at a glance rather than changed.
 */
function CurrencyChoice({
  value,
  onChange,
}: {
  value: FormState["currencyDisplay"];
  onChange: (next: FormState["currencyDisplay"]) => void;
}) {
  const options = [
    { key: "toman", label: "تومان", hint: "۲۵,۰۰۰" },
    { key: "rial", label: "ریال", hint: "۲۵۰,۰۰۰" },
  ] as const;

  return (
    <div role="radiogroup" aria-label="واحد نمایش مبلغ" className="grid grid-cols-2 gap-2">
      {options.map((option) => {
        const active = value === option.key;
        return (
          <button
            key={option.key}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.key)}
            className={`flex min-h-11 flex-col items-center justify-center rounded-xl border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring focus-visible:ring-amber-400/40 ${
              active
                ? "border-amber-200 bg-amber-100 font-semibold text-amber-950"
                : "border-stone-200/80 bg-card text-stone-600 hover:bg-stone-50 hover:text-stone-950"
            }`}
          >
            <span>{option.label}</span>
            <span className={`text-[11px] font-normal ${active ? "text-amber-800" : "text-muted-foreground"}`}>
              {option.hint}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Business and active-branch profile, available after the initial wizard as well. */
export function BusinessSettings() {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  /** Nothing to save until something is edited — the save bar says so. */
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { ok, data } = await api<BusinessState>("/api/settings/business");
    if (ok) {
      setForm(fromState(data));
      setError("");
    } else {
      setError(errorMessage(data.error));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function change<K extends keyof FormState>(key: K, value: FormState[K]) {
    setSaved(false);
    setDirty(true);
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setSaved(false);
    const { ok, data } = await api<{ error?: string }>("/api/settings/business", {
      method: "PUT",
      body: JSON.stringify(form),
    });
    setSaving(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setSaved(true);
    setDirty(false);
  }

  if (loading) {
    return (
      <div className="space-y-4" aria-live="polite">
        <span className="sr-only">در حال بارگذاری…</span>
        {[0, 1, 2].map((row) => (
          <div key={row} className="ops-skeleton h-40 rounded-2xl" />
        ))}
      </div>
    );
  }

  return (
    <form onSubmit={save} className="space-y-4 sm:space-y-5">
      <ErrorBox>{error}</ErrorBox>
      {saved ? <InfoBox>اطلاعات کسب‌وکار ذخیره شد.</InfoBox> : null}

      <SectionCard title="هویت کسب‌وکار" description="نامی که در داشبورد و رسید مشتری نمایش داده می‌شود.">
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="نام کسب‌وکار">
            <input
              className={inputClass}
              value={form.businessName}
              onChange={(e) => change("businessName", e.target.value)}
              required
            />
          </Field>
          <Field label="نام حقوقی / صاحب امتیاز" hint="روی فاکتور رسمی چاپ می‌شود.">
            <input
              className={inputClass}
              value={form.legalName}
              onChange={(e) => change("legalName", e.target.value)}
              placeholder="اختیاری"
            />
          </Field>
          <Field label="شناسه / شماره مالیاتی">
            <input
              className={inputClass}
              dir="ltr"
              value={form.taxId}
              onChange={(e) => change("taxId", e.target.value)}
              placeholder="اختیاری"
            />
          </Field>
          <Field label="ایمیل پشتیبانی">
            <input
              className={inputClass}
              dir="ltr"
              type="email"
              value={form.email}
              onChange={(e) => change("email", e.target.value)}
              placeholder="info@example.com"
            />
          </Field>
          <Field label="وب‌سایت">
            <input
              className={inputClass}
              dir="ltr"
              value={form.website}
              onChange={(e) => change("website", e.target.value)}
              placeholder="https://example.com"
            />
          </Field>
        </div>
      </SectionCard>

      <SectionCard title="واحد نمایش مبلغ" description="فقط شکل نمایش عوض می‌شود؛ مبلغ‌های ثبت‌شده دست‌نخورده می‌مانند.">
        <CurrencyChoice value={form.currencyDisplay} onChange={(next) => change("currencyDisplay", next)} />
      </SectionCard>

      <SectionCard title="شعبهٔ فعال" description="این اطلاعات برای شعبه‌ای که اکنون انتخاب شده است استفاده می‌شود.">
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="نام شعبه">
            <input
              className={inputClass}
              value={form.locationName}
              onChange={(e) => change("locationName", e.target.value)}
              required
            />
          </Field>
          <Field label="شماره تماس">
            <input
              className={inputClass}
              dir="ltr"
              inputMode="tel"
              value={form.phone}
              onChange={(e) => change("phone", e.target.value)}
            />
          </Field>
        </div>
        <Field label="نشانی">
          <textarea
            className={`${inputClass} h-auto min-h-24 py-2`}
            value={form.address}
            onChange={(e) => change("address", e.target.value)}
          />
        </Field>
      </SectionCard>

      <SectionCard title="متن پایین رسید" description="مثلاً پیام تشکر، شرایط مرجوعی یا راه ارتباطی.">
        <textarea
          className={`${inputClass} h-auto min-h-24 py-2`}
          value={form.receiptFooter}
          onChange={(e) => change("receiptFooter", e.target.value)}
          placeholder="از خرید شما متشکریم"
        />
      </SectionCard>

      {/*
        The button leads and the status follows it, rather than the other way
        round: the assistant's floating button occupies the inline-end corner
        of every screen, and whatever sits there gets covered. A line of text
        can afford that; the form's only submit cannot.
      */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-stone-200/80 bg-card px-4 py-3 shadow-[0_1px_2px_rgb(41_37_36/0.035)]">
        <Button type="submit" size="lg" disabled={saving || !dirty} className="px-6 font-semibold">
          {saving ? "در حال ذخیره…" : "ذخیرهٔ اطلاعات"}
        </Button>
        <p className="min-w-0 text-xs leading-5 text-muted-foreground">
          {dirty ? "تغییرات ذخیره نشده است." : "همه‌چیز ذخیره شده است."}
        </p>
      </div>
    </form>
  );
}
