"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toLatinDigits } from "@/lib/digits";
import {
  ErrorBox,
  Field,
  InfoBox,
  PrimaryButton,
  api,
  errorMessage,
  inputClass,
} from "@/app/dashboard/ui";
import { LoadingSkeleton, SectionCard } from "@/app/dashboard/page-chrome";

type OverheadMode = "automatic" | "manual";

interface PricingPolicy {
  defaultMarginPercent: number | null;
  fallbackOverheadPercent: number | null;
  overheadMode: OverheadMode;
  costDriftThresholdPercent: number;
}

interface EffectiveOverhead {
  ratePercent: number | null;
  source: "ledger" | "fallback" | "none";
  ledgerRatePercent: number | null;
  lookbackDays: number;
}

interface PricingResponse {
  pricing: PricingPolicy;
  effectiveOverhead: EffectiveOverhead | null;
  error?: string;
}

interface PricingForm {
  defaultMarginPercent: string;
  fallbackOverheadPercent: string;
  overheadMode: OverheadMode;
  costDriftThresholdPercent: string;
}

const EMPTY_FORM: PricingForm = {
  defaultMarginPercent: "",
  fallbackOverheadPercent: "",
  overheadMode: "automatic",
  costDriftThresholdPercent: "20",
};

function formFromPolicy(policy: PricingPolicy): PricingForm {
  return {
    defaultMarginPercent:
      policy.defaultMarginPercent == null ? "" : String(policy.defaultMarginPercent),
    fallbackOverheadPercent:
      policy.fallbackOverheadPercent == null ? "" : String(policy.fallbackOverheadPercent),
    overheadMode: policy.overheadMode === "manual" ? "manual" : "automatic",
    costDriftThresholdPercent: String(policy.costDriftThresholdPercent),
  };
}

function formsMatch(left: PricingForm, right: PricingForm): boolean {
  return (
    left.defaultMarginPercent === right.defaultMarginPercent &&
    left.fallbackOverheadPercent === right.fallbackOverheadPercent &&
    left.overheadMode === right.overheadMode &&
    left.costDriftThresholdPercent === right.costDriftThresholdPercent
  );
}

/** Empty means "clear this optional value"; otherwise accept a finite percentage below max. */
function parseOptionalPercent(
  raw: string,
  max: number,
): { ok: true; value: number | null } | { ok: false } {
  const trimmed = toLatinDigits(raw).trim();
  if (trimmed === "") return { ok: true, value: null };
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0 || value >= max) return { ok: false };
  return { ok: true, value };
}

function formatPercent(value: number): string {
  return `${new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 2 }).format(value)}٪`;
}

function CardTitle({ eyebrow, children }: { eyebrow: string; children: string }) {
  return (
    <span className="block">
      <span className="block text-xs font-semibold text-amber-700 dark:text-amber-300">
        {eyebrow}
      </span>
      <span className="mt-1 block text-base font-semibold text-foreground sm:text-lg">
        {children}
      </span>
    </span>
  );
}

function PercentField({
  id,
  label,
  hint,
  value,
  placeholder,
  disabled,
  invalid,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  invalid?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <div className="relative max-w-sm">
        <PersianNumberInput
          id={id}
          className={`${inputClass} pe-9`}
          dir="ltr"
          inputMode="decimal"
          allowNegative={false}
          grouping={false}
          maxLength={8}
          value={value}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-sm text-muted-foreground"
        >
          ٪
        </span>
      </div>
    </Field>
  );
}

function OverheadStatus({
  form,
  status,
}: {
  form: PricingForm;
  status: EffectiveOverhead | null;
}) {
  const fallback = parseOptionalPercent(form.fallbackOverheadPercent, 1000);
  const fallbackValue = fallback.ok ? fallback.value : null;

  let message: string;
  if (form.overheadMode === "manual") {
    message =
      fallbackValue == null
        ? "برای حالت دستی یک درصد سربار وارد کنید."
        : `پس از ذخیره، سربار ثابت ${formatPercent(fallbackValue)} در همهٔ پیشنهادها استفاده می‌شود.`;
  } else if (status?.ledgerRatePercent != null) {
    message = `نرخ فعلی دفتر ${formatPercent(status.ledgerRatePercent)} است و از داده‌های ${new Intl.NumberFormat("fa-IR").format(status.lookbackDays)} روز اخیر به‌دست آمده؛ برآورد جایگزین فعلاً استفاده نمی‌شود.`;
  } else if (fallbackValue != null) {
    message = `تا وقتی فروش کافی برای محاسبه از دفتر وجود ندارد، برآورد ${formatPercent(fallbackValue)} استفاده می‌شود.`;
  } else if (status) {
    message = "هنوز نرخ قابل محاسبه‌ای در دفتر نیست و برآورد جایگزینی هم تعیین نشده؛ فعلاً سربار صفر در نظر گرفته می‌شود.";
  } else {
    message = "وضعیت لحظه‌ای دفتر در دسترس نیست؛ تنظیمات را همچنان می‌توانید ویرایش و ذخیره کنید.";
  }

  return (
    <div className="rounded-xl bg-muted/60 px-3 py-3 text-sm leading-6 text-muted-foreground">
      <span className="font-medium text-foreground">وضعیت نرخ مؤثر: </span>
      {message}
    </div>
  );
}

/** Business-wide cost-plus pricing policy for recipe-backed menu items. */
export function PricingSettings() {
  const [form, setForm] = useState<PricingForm>(EMPTY_FORM);
  const [savedForm, setSavedForm] = useState<PricingForm | null>(null);
  const [effectiveOverhead, setEffectiveOverhead] = useState<EffectiveOverhead | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [invalidFields, setInvalidFields] = useState<Set<keyof PricingForm>>(new Set());

  const dirty = savedForm != null && !formsMatch(form, savedForm);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    setError("");
    setSaved(false);
    try {
      const { ok, data } = await api<PricingResponse>("/api/settings/pricing");
      if (!ok) {
        setLoadError(errorMessage(data.error));
        return;
      }
      const nextForm = formFromPolicy(data.pricing);
      setForm(nextForm);
      setSavedForm(nextForm);
      setEffectiveOverhead(data.effectiveOverhead ?? null);
      setInvalidFields(new Set());
    } catch {
      setLoadError("ارتباط با سرور برقرار نشد. اتصال شبکه را بررسی و دوباره تلاش کنید.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function change<K extends keyof PricingForm>(key: K, value: PricingForm[K]) {
    setSaved(false);
    setError("");
    setInvalidFields((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    setForm((current) => ({ ...current, [key]: value }));
  }

  function reset() {
    if (!savedForm) return;
    setForm(savedForm);
    setError("");
    setSaved(false);
    setInvalidFields(new Set());
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();

    const margin = parseOptionalPercent(form.defaultMarginPercent, 100);
    const overhead = parseOptionalPercent(form.fallbackOverheadPercent, 1000);
    const drift = parseOptionalPercent(form.costDriftThresholdPercent, 1000);
    const invalid = new Set<keyof PricingForm>();
    if (!margin.ok) invalid.add("defaultMarginPercent");
    if (!overhead.ok || (form.overheadMode === "manual" && overhead.ok && overhead.value == null)) {
      invalid.add("fallbackOverheadPercent");
    }
    if (!drift.ok || drift.value == null || drift.value <= 0) {
      invalid.add("costDriftThresholdPercent");
    }
    setInvalidFields(invalid);

    if (invalid.has("defaultMarginPercent")) {
      setError("حاشیه سود باید عددی از ۰ تا کمتر از ۱۰۰ باشد.");
      return;
    }
    if (invalid.has("fallbackOverheadPercent")) {
      setError(
        form.overheadMode === "manual" && overhead.ok && overhead.value == null
          ? "برای روش دستی، درصد سربار را وارد کنید."
          : "سربار برآوردی باید عددی از ۰ تا کمتر از ۱۰۰۰ باشد.",
      );
      return;
    }
    if (invalid.has("costDriftThresholdPercent")) {
      setError("آستانهٔ تغییر بها باید بیشتر از ۰ و کمتر از ۱۰۰۰ باشد.");
      return;
    }
    if (!margin.ok || !overhead.ok || !drift.ok || drift.value == null) return;

    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const { ok, data } = await api<PricingResponse>("/api/settings/pricing", {
        method: "PUT",
        body: JSON.stringify({
          defaultMarginPercent: margin.value,
          fallbackOverheadPercent: overhead.value,
          overheadMode: form.overheadMode,
          costDriftThresholdPercent: drift.value,
        }),
      });
      if (!ok) {
        setError(errorMessage(data.error));
        return;
      }
      const nextForm = formFromPolicy(data.pricing);
      setForm(nextForm);
      setSavedForm(nextForm);
      setEffectiveOverhead(data.effectiveOverhead ?? null);
      setInvalidFields(new Set());
      setSaved(true);
    } catch {
      setError("ذخیره انجام نشد. اتصال شبکه را بررسی و دوباره تلاش کنید.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <LoadingSkeleton rows={5} label="در حال بارگذاری تنظیمات قیمت‌گذاری" />;
  }

  if (loadError || !savedForm) {
    return (
      <div className="space-y-4">
        <ErrorBox>{loadError || "بارگذاری تنظیمات قیمت‌گذاری ممکن نشد."}</ErrorBox>
        <SectionCard
          title="بارگذاری دوباره"
          description="تا تنظیمات فعلی دریافت نشود، فرم نمایش داده نمی‌شود تا داده‌ای ناخواسته بازنویسی نشود."
        >
          <Button type="button" onClick={() => void load()}>
            تلاش دوباره
          </Button>
        </SectionCard>
      </div>
    );
  }

  return (
    <form onSubmit={save} className="space-y-6" noValidate>
      <ErrorBox>{error}</ErrorBox>
      {saved ? <InfoBox>تنظیمات قیمت‌گذاری با موفقیت ذخیره شد.</InfoBox> : null}

      <SectionCard
        title={<CardTitle eyebrow="سیاست قیمت">هدف حاشیه سود پیش‌فرض</CardTitle>}
        description="قیمت پیشنهادی طوری محاسبه می‌شود که پس از پوشش بهای مواد و سربار، این سهم از قیمت فروش باقی بماند. مقدار اختصاصی هر آیتم بر این مقدار اولویت دارد."
        footer="اگر این فیلد را خالی بگذارید، برای آیتم‌هایی که حاشیه سود اختصاصی ندارند قیمت پیشنهادی ساخته نمی‌شود."
      >
        <PercentField
          id="pricing-default-margin"
          label="حاشیه سود پیش‌فرض"
          hint="از ۰ تا کمتر از ۱۰۰؛ برای نمونه ۳۰ یعنی ۳۰٪ از قیمت فروش."
          value={form.defaultMarginPercent}
          placeholder="مثلاً ۳۰"
          disabled={saving}
          invalid={invalidFields.has("defaultMarginPercent")}
          onChange={(value) => change("defaultMarginPercent", value)}
        />
      </SectionCard>

      <SectionCard
        title={<CardTitle eyebrow="سربار کسب‌وکار">روش محاسبهٔ سربار</CardTitle>}
        description="سربار شامل هزینه‌هایی مثل اجاره، آب‌وبرق و حقوق است. روش خودکار از دفتر حسابداری استفاده می‌کند؛ روش دستی همیشه نرخ ثابت شما را نگه می‌دارد."
      >
        <fieldset disabled={saving} className="space-y-4">
          <legend className="mb-2 text-sm font-medium text-foreground">روش محاسبه</legend>
          <RadioGroup
            value={form.overheadMode}
            onValueChange={(value) => change("overheadMode", value as OverheadMode)}
            className="grid gap-2 sm:grid-cols-2"
            aria-label="روش محاسبهٔ سربار"
          >
            {([
              {
                value: "automatic",
                title: "خودکار از دفتر",
                description: "نرخ ۳۰ روز اخیر؛ تا آماده‌شدن داده‌ها از برآورد جایگزین استفاده می‌شود.",
              },
              {
                value: "manual",
                title: "درصد دستی ثابت",
                description: "همیشه درصد واردشده را به‌کار می‌برد و آن را با نرخ دفتر جایگزین نمی‌کند.",
              },
            ] as const).map((option) => {
              const active = form.overheadMode === option.value;
              return (
                <label
                  key={option.value}
                  htmlFor={`pricing-overhead-${option.value}`}
                  className={`flex min-h-20 cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${
                    active
                      ? "border-amber-200 bg-amber-100 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/20 dark:text-amber-200"
                      : "border-border/80 bg-card hover:bg-muted"
                  }`}
                >
                  <RadioGroupItem
                    id={`pricing-overhead-${option.value}`}
                    value={option.value}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{option.title}</span>
                    <span
                      className={`mt-1 block text-xs leading-5 ${
                        active
                          ? "text-amber-800 dark:text-amber-300"
                          : "text-muted-foreground"
                      }`}
                    >
                      {option.description}
                    </span>
                  </span>
                </label>
              );
            })}
          </RadioGroup>

          <PercentField
            id="pricing-fallback-overhead"
            label={
              form.overheadMode === "manual"
                ? "درصد سربار دستی"
                : "برآورد جایگزین سربار (اختیاری)"
            }
            hint={
              form.overheadMode === "manual"
                ? "این مقدار در همهٔ پیشنهادهای قیمت استفاده می‌شود."
                : "فقط وقتی دفتر هنوز درآمدی برای محاسبهٔ نرخ ندارد استفاده می‌شود."
            }
            value={form.fallbackOverheadPercent}
            placeholder="مثلاً ۳۵"
            disabled={saving}
            invalid={invalidFields.has("fallbackOverheadPercent")}
            onChange={(value) => change("fallbackOverheadPercent", value)}
          />
        </fieldset>

        <OverheadStatus form={form} status={effectiveOverhead} />
      </SectionCard>

      <SectionCard
        title={<CardTitle eyebrow="کنترل تغییر هزینه">آستانهٔ هشدار تغییر بهای رسپی</CardTitle>}
        description="وقتی بهای تمام‌شدهٔ یک آیتم نسبت به مبنای قیمت فعلی به این اندازه یا بیشتر افزایش کند، آن آیتم در گزارش تغییر بها علامت‌گذاری می‌شود."
        footer="مقدار پیش‌فرض ۲۰٪ است. صفر مجاز نیست، چون حتی آیتم‌های بدون تغییر را هم به‌اشتباه علامت‌گذاری می‌کند."
      >
        <PercentField
          id="pricing-cost-drift"
          label="درصد افزایش برای هشدار"
          hint="بیشتر از ۰ و کمتر از ۱۰۰۰."
          value={form.costDriftThresholdPercent}
          placeholder="مثلاً ۲۰"
          disabled={saving}
          invalid={invalidFields.has("costDriftThresholdPercent")}
          onChange={(value) => change("costDriftThresholdPercent", value)}
        />
      </SectionCard>

      <SectionCard
        bodyClassName="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
      >
        <div aria-live="polite" className="text-sm">
          <p className="font-medium text-foreground">
            {dirty ? "تغییرات ذخیره‌نشده دارید." : "همهٔ تغییرات ذخیره شده‌اند."}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            ذخیره فقط پیشنهادها و هشدارهای بعدی را تغییر می‌دهد و قیمت فعلی آیتم‌ها را خودکار عوض نمی‌کند.
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
          <div className="w-full sm:w-48">
            <PrimaryButton disabled={saving || !dirty}>
              {saving ? "در حال ذخیره…" : "ذخیرهٔ قیمت‌گذاری"}
            </PrimaryButton>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={saving || !dirty}
            onClick={reset}
            className="w-full sm:w-auto"
          >
            بازگردانی تغییرات
          </Button>
        </div>
      </SectionCard>
    </form>
  );
}
