"use client";

import { useCallback, useEffect, useState } from "react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { ErrorBox, Field, InfoBox, PrimaryButton, api, errorMessage, inputClass } from "../ui";
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

/** Business and active-branch profile, available after the initial wizard as well. */
export function BusinessSettings() {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

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
  }

  if (loading) return <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>;

  return (
    <form onSubmit={save} className="space-y-6">
      <ErrorBox>{error}</ErrorBox>
      {saved ? <InfoBox>اطلاعات کسب‌وکار ذخیره شد.</InfoBox> : null}

      <SectionCard title="هویت کسب‌وکار">
        <p className="mb-4 text-sm text-muted-foreground">نامی که در داشبورد و رسید مشتری نمایش داده می‌شود.</p>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="نام کسب‌وکار">
            <input className={inputClass} value={form.businessName} onChange={(e) => change("businessName", e.target.value)} required />
          </Field>
          <Field label="نام حقوقی / صاحب امتیاز">
            <input className={inputClass} value={form.legalName} onChange={(e) => change("legalName", e.target.value)} placeholder="اختیاری" />
          </Field>
          <Field label="شناسه / شماره مالیاتی">
            <input className={inputClass} dir="ltr" value={form.taxId} onChange={(e) => change("taxId", e.target.value)} placeholder="اختیاری" />
          </Field>
          <Field label="ایمیل پشتیبانی">
            <input className={inputClass} dir="ltr" type="email" value={form.email} onChange={(e) => change("email", e.target.value)} placeholder="info@example.com" />
          </Field>
          <Field label="وب‌سایت">
            <input className={inputClass} dir="ltr" value={form.website} onChange={(e) => change("website", e.target.value)} placeholder="https://example.com" />
          </Field>
          <Field label="واحد نمایش مبلغ">
            <SearchableSelect
              value={form.currencyDisplay}
              onChange={(value) => change("currencyDisplay", value === "rial" ? "rial" : "toman")}
              options={[
                { value: "toman", label: "تومان" },
                { value: "rial", label: "ریال" },
              ]}
            />
          </Field>
        </div>
      </SectionCard>

      <SectionCard title="شعبهٔ فعال">
        <p className="mb-4 text-sm text-muted-foreground">این اطلاعات برای شعبه‌ای که اکنون انتخاب شده است استفاده می‌شود.</p>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="نام شعبه">
            <input className={inputClass} value={form.locationName} onChange={(e) => change("locationName", e.target.value)} required />
          </Field>
          <Field label="شماره تماس">
            <input className={inputClass} dir="ltr" inputMode="tel" value={form.phone} onChange={(e) => change("phone", e.target.value)} />
          </Field>
        </div>
        <Field label="نشانی">
          <textarea className={`${inputClass} min-h-24 py-2`} value={form.address} onChange={(e) => change("address", e.target.value)} />
        </Field>
      </SectionCard>

      <SectionCard title="متن پایین رسید">
        <p className="mb-4 text-sm text-muted-foreground">مثلاً پیام تشکر، شرایط مرجوعی یا راه ارتباطی.</p>
        <textarea className={`${inputClass} min-h-24 py-2`} value={form.receiptFooter} onChange={(e) => change("receiptFooter", e.target.value)} placeholder="از خرید شما متشکریم" />
      </SectionCard>

      <div className="max-w-xs">
        <PrimaryButton disabled={saving}>{saving ? "در حال ذخیره…" : "ذخیرهٔ اطلاعات"}</PrimaryButton>
      </div>
    </form>
  );
}
