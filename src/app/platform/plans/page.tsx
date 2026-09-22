"use client";

/**
 * Super-admin «پلن‌ساز» — the plan builder.
 *
 * For each billing plan the operator picks functions (feature flags) and sets
 * the cost model per function:
 *  - included  — part of the plan at no extra cost
 *  - monthly   — a monthly add-on fee
 *  - per_use   — metered: each use costs `price` from the business wallet
 *  - addon     — a one-off purchase the business owns
 * plus optional free promotions: free until a date (limited time) or free for
 * N uses (limited use). Plan-level monthly fee is editable as well.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Loader2Icon, PlusIcon, Settings2Icon, Trash2Icon } from "lucide-react";
import { formatJalali, toGregorian } from "@/lib/jalali";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import { api, Button, Card, ErrorBox, Field, InfoBox, inputClass, PlatformPageSkeleton, useCan } from "../ui";
import { PersianNumberInput } from "@/components/ui/persian-number-input";

interface Plan {
  key: string;
  name: string;
  description: string | null;
  monthlyPriceRial: number | null;
  /** اعتبار ماهانهٔ هوش مصنوعی که در این پلن گنجانده شده (ریال؛ null = بدون اعتبار). */
  monthlyAiCreditRial: number | null;
  isActive: boolean;
  sortOrder: number;
}
interface PlanFeature {
  id: string;
  planKey: string;
  featureKey: string;
  featureName: string | null;
  pricingModel: "included" | "monthly" | "per_use" | "addon";
  priceRial: number;
  freeUntil: string | null;
  freeLimit: number | null;
  sortOrder: number;
}
interface CatalogueEntry {
  key: string;
  name: string;
  description: string | null;
}

const MODEL_LABELS: Record<PlanFeature["pricingModel"], string> = {
  included: "رایگان در پلن",
  monthly: "ماهانه (هزینه ثابت)",
  per_use: "به ازای هر استفاده",
  addon: "خرید یک‌باره (افزونه)",
};

function toman(rial: number): string {
  return toPersianDigits(Math.round(rial / 10).toLocaleString("en-US").replace(/,/g, "٬"));
}

/** ISO timestamp for the free-until input: a Jalali date is entered, converted
 *  with the same shared Jalali math the rest of the app uses. */
function jalaliInputToIso(value: string): string | null {
  if (!value) return null;
  const m = value.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  // A Gregorian date (year > 1500) passes through.
  if (y > 1500) return new Date(`${value.slice(0, 10)}T23:59:59+03:30`).toISOString();
  // Jalali → Gregorian via the shared, tested converter.
  const g = toGregorian(y, mo, d);
  return new Date(
    `${g.gy}-${String(g.gm).padStart(2, "0")}-${String(g.gd).padStart(2, "0")}T23:59:59+03:30`,
  ).toISOString();
}

export default function PlanBuilderPage() {
  const canManage = useCan()("billing.manage");
  const [loading, setLoading] = useState(true);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [featuresByPlan, setFeaturesByPlan] = useState<Record<string, PlanFeature[]>>({});
  const [catalogue, setCatalogue] = useState<CatalogueEntry[]>([]);
  const [selectedPlan, setSelectedPlan] = useState<string>("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [newPlanName, setNewPlanName] = useState("");
  const [newPlanPrice, setNewPlanPrice] = useState("");
  const [featureKey, setFeatureKey] = useState("");
  const [pricingModel, setPricingModel] = useState<PlanFeature["pricingModel"]>("per_use");
  const [priceToman, setPriceToman] = useState("");
  const [freeUntil, setFreeUntil] = useState("");
  const [freeLimit, setFreeLimit] = useState("");
  const [newPlanAiCredit, setNewPlanAiCredit] = useState("");
  const [planAiCredit, setPlanAiCredit] = useState("");

  const load = useCallback(async () => {
    const { ok, data } = await api<{
      plans: Plan[];
      featuresByPlan: Record<string, PlanFeature[]>;
      catalogue: CatalogueEntry[];
      error?: string;
    }>("/api/platform/billing/plans");
    if (ok) {
      setPlans(data.plans);
      setFeaturesByPlan(data.featuresByPlan);
      setCatalogue(data.catalogue);
      setSelectedPlan((current) => current || data.plans[0]?.key || "");
    } else {
      setError(data.error ?? "بارگذاری انجام نشد.");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createPlan(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    if (!newPlanName.trim()) return;
    setBusy("plan");
    setError("");
    const priceTomanValue = Number(toLatinDigits(newPlanPrice || "0"));
    const { ok, data } = await api<{ plan?: Plan; error?: string }>("/api/platform/billing/plans", {
      method: "POST",
      body: JSON.stringify({
        name: newPlanName.trim(),
        monthlyPriceRial: priceTomanValue > 0 ? priceTomanValue * 10 : null,
        monthlyAiCreditRial:
          Number(toLatinDigits(newPlanAiCredit || "0")) > 0
            ? Number(toLatinDigits(newPlanAiCredit)) * 10
            : null,
        isActive: true,
        sortOrder: plans.length + 1,
      }),
    });
    setBusy(null);
    if (ok && data.plan) {
      setInfo(`پلن «${data.plan.name}» ساخته شد.`);
      setNewPlanName("");
      setNewPlanPrice("");
      setNewPlanAiCredit("");
      setSelectedPlan(data.plan.key);
      void load();
    } else {
      setError(data.error ?? "ساخت پلن انجام نشد.");
    }
  }

  async function saveFeature(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    if (!selectedPlan || !featureKey) {
      setError("پلن و قابلیت را انتخاب کنید.");
      return;
    }
    setError("");
    setBusy("feature");
    const priceTomanValue = Math.max(0, Number(toLatinDigits(priceToman || "0")));
    const body: Record<string, unknown> = {
      featureKey,
      pricingModel,
      priceRial: priceTomanValue * 10,
      freeUntil: pricingModel === "per_use" ? jalaliInputToIso(freeUntil) : null,
      freeLimit:
        pricingModel === "per_use" && freeLimit
          ? Math.max(0, Number(toLatinDigits(freeLimit)))
          : null,
      sortOrder: (featuresByPlan[selectedPlan]?.length ?? 0) + 1,
    };
    const { ok, data } = await api<{ error?: string }>(
      `/api/platform/billing/plans/${selectedPlan}/features`,
      { method: "POST", body: JSON.stringify(body) },
    );
    setBusy(null);
    if (ok) {
      setInfo("قیمت‌گذاری قابلیت ذخیره شد.");
      setFeatureKey("");
      setPriceToman("");
      setFreeUntil("");
      setFreeLimit("");
      void load();
    } else {
      setError(data.error ?? "ذخیره انجام نشد.");
    }
  }

  async function removeFeature(feature: PlanFeature) {
    setBusy(`del-${feature.id}`);
    await api(
      `/api/platform/billing/plans/${selectedPlan}/features?featureKey=${encodeURIComponent(feature.featureKey)}`,
      { method: "DELETE" },
    );
    setBusy(null);
    void load();
  }

  const currentFeatures = featuresByPlan[selectedPlan] ?? [];
  const usedKeys = new Set(currentFeatures.map((f) => f.featureKey));
  const availableCatalogue = catalogue.filter((c) => !usedKeys.has(c.key));
  const selectedPlanRow = plans.find((p) => p.key === selectedPlan) ?? null;

  // The per-plan AI credit editor mirrors the selected plan's stored value
  // until the operator edits it (a controlled field, re-synced on plan/data
  // change rather than kept in a second source of truth).
  useEffect(() => {
    setPlanAiCredit(
      selectedPlanRow?.monthlyAiCreditRial
        ? String(Math.round(selectedPlanRow.monthlyAiCreditRial / 10))
        : "",
    );
  }, [selectedPlanRow?.key, selectedPlanRow?.monthlyAiCreditRial]);

  async function savePlanAiCredit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    if (!selectedPlanRow) return;
    setBusy("ai-credit");
    setError("");
    const creditToman = Math.max(0, Number(toLatinDigits(planAiCredit || "0")));
    const { ok, data } = await api<{ plan?: Plan; error?: string }>("/api/platform/billing/plans", {
      method: "POST",
      body: JSON.stringify({
        key: selectedPlanRow.key,
        name: selectedPlanRow.name,
        description: selectedPlanRow.description ?? undefined,
        monthlyPriceRial: selectedPlanRow.monthlyPriceRial,
        monthlyAiCreditRial: creditToman > 0 ? creditToman * 10 : null,
        isActive: selectedPlanRow.isActive,
        sortOrder: selectedPlanRow.sortOrder,
      }),
    });
    setBusy(null);
    if (ok) {
      setInfo(
        creditToman > 0
          ? `اعتبار ماهانهٔ هوش مصنوعی پلن «${selectedPlanRow.name}» روی ${toman(creditToman * 10)} تومان تنظیم شد.`
          : `اعتبار ماهانهٔ هوش مصنوعی پلن «${selectedPlanRow.name}» حذف شد.`,
      );
      void load();
    } else {
      setError(data.error ?? "ذخیره انجام نشد.");
    }
  }

  if (loading) return <PlatformPageSkeleton />;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 sm:space-y-6">
      <header className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-sky-500/15 text-sky-700 dark:text-sky-300">
          <Settings2Icon className="size-5" />
        </span>
        <div>
          <h1 className="text-lg font-bold text-foreground">پلن‌ساز</h1>
          <p className="text-sm text-muted-foreground">
            انتخاب قابلیت‌ها برای هر پلن، تعیین هزینهٔ هر قابلیت، و تعریف دورهٔ رایگان یا تعداد استفادهٔ رایگان
          </p>
        </div>
      </header>

      {error && <ErrorBox>{error}</ErrorBox>}
      {info && <InfoBox>{info}</InfoBox>}

      {canManage && (
        <Card title="ساخت پلن جدید">
          <form onSubmit={createPlan} className="grid gap-3 sm:grid-cols-4 sm:items-end">
            <Field label="نام پلن">
              <input
                className={inputClass}
                value={newPlanName}
                onChange={(e) => setNewPlanName(e.target.value)}
                placeholder="مثلاً پلن طلایی"
              />
            </Field>
            <Field label="هزینهٔ ماهانهٔ پایه (تومان) — اختیاری">
              <PersianNumberInput
                className={inputClass}
                inputMode="numeric"
                value={newPlanPrice}
                onChange={(e) => setNewPlanPrice(e.target.value)}
                placeholder="0 = بدون هزینهٔ پایه"
              />
            </Field>
            <Field label="اعتبار ماهانهٔ هوش مصنوعی (تومان) — اختیاری">
              <PersianNumberInput
                className={inputClass}
                inputMode="numeric"
                value={newPlanAiCredit}
                onChange={(e) => setNewPlanAiCredit(e.target.value)}
                placeholder="مثلاً ۱۰۰٬۰۰۰"
              />
            </Field>
            <Button type="submit" disabled={busy === "plan"} className="sm:col-span-2">
              {busy === "plan" ? <Loader2Icon className="size-4 animate-spin" /> : <PlusIcon className="size-4" />}
              ساخت پلن
            </Button>
          </form>
        </Card>
      )}

      <Card title="پلن‌ها">
        <div className="mb-4 flex flex-wrap gap-2">
          {plans.map((plan) => (
            <button
              key={plan.key}
              type="button"
              onClick={() => setSelectedPlan(plan.key)}
              className={`rounded-full border px-4 py-1.5 text-sm transition ${
                selectedPlan === plan.key
                  ? "border-sky-400/60 bg-sky-500/20 text-sky-900 dark:text-sky-100"
                  : "border-border text-foreground hover:bg-muted"
              }`}
            >
              {plan.name}
              {plan.monthlyPriceRial != null && plan.monthlyPriceRial > 0 && (
                <span className="mr-2 text-xs text-muted-foreground">{toman(plan.monthlyPriceRial)} ت/ماه</span>
              )}
              {plan.monthlyAiCreditRial != null && plan.monthlyAiCreditRial > 0 && (
                <span className="mr-2 text-xs text-violet-700 dark:text-violet-300">
                  ✦ {toman(plan.monthlyAiCreditRial)} ت اعتبار AI
                </span>
              )}
            </button>
          ))}
        </div>

        {canManage && selectedPlanRow && (
          <form
            onSubmit={savePlanAiCredit}
            className="mb-4 grid gap-3 rounded-xl border border-violet-300/60 bg-violet-50/40 p-4 dark:border-violet-500/30 dark:bg-violet-500/10 sm:grid-cols-3 sm:items-end"
          >
            <p className="text-sm font-semibold text-foreground sm:col-span-3">
              سقف هوش مصنوعی این پلن
              <span className="block mt-1 text-xs font-normal text-muted-foreground">
                اعتباری که هر ماه پیش از کیف پول کسب‌وکار مصرف می‌شود؛ هزینهٔ بیش از آن از کیف پول کسر می‌شود.
              </span>
            </p>
            <Field label="اعتبار ماهانهٔ هوش مصنوعی (تومان)">
              <PersianNumberInput
                className={inputClass}
                inputMode="numeric"
                value={planAiCredit}
                onChange={(e) => setPlanAiCredit(e.target.value)}
                placeholder="0 = بدون اعتبار ماهانه"
              />
            </Field>
            <Button type="submit" disabled={busy === "ai-credit"} className="sm:col-span-2">
              {busy === "ai-credit" ? <Loader2Icon className="size-4 animate-spin" /> : null}
              ذخیرهٔ سقف هوش مصنوعی
            </Button>
          </form>
        )}

        {canManage && (
          <form onSubmit={saveFeature} className="rounded-xl border border-border bg-card p-4">
            <p className="mb-3 text-sm font-semibold text-foreground">افزودن قابلیت به این پلن</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="قابلیت (عملکرد)">
                <select className={inputClass} value={featureKey} onChange={(e) => setFeatureKey(e.target.value)}>
                  <option value="">انتخاب کنید…</option>
                  {availableCatalogue.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.name} ({c.key})
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="مدل هزینه">
                <select
                  className={inputClass}
                  value={pricingModel}
                  onChange={(e) => setPricingModel(e.target.value as PlanFeature["pricingModel"])}
                >
                  <option value="included">{MODEL_LABELS.included}</option>
                  <option value="monthly">{MODEL_LABELS.monthly}</option>
                  <option value="per_use">{MODEL_LABELS.per_use}</option>
                  <option value="addon">{MODEL_LABELS.addon}</option>
                </select>
              </Field>
              {(pricingModel === "per_use" || pricingModel === "monthly" || pricingModel === "addon") && (
                <Field label={pricingModel === "monthly" ? "هزینهٔ ماهانه (تومان)" : pricingModel === "addon" ? "قیمت خرید (تومان)" : "هزینهٔ هر استفاده (تومان)"}>
                  <PersianNumberInput
                    className={inputClass}
                    inputMode="numeric"
                    value={priceToman}
                    onChange={(e) => setPriceToman(e.target.value)}
                    placeholder="0 = رایگان"
                  />
                </Field>
              )}
              {pricingModel === "per_use" && (
                <>
                  <Field label="رایگان تا تاریخ (هجری شمسی) — اختیاری">
                    <input
                      className={inputClass}
                      placeholder="مثلاً ۱۴۰۴/۱۲/۲۹"
                      value={freeUntil}
                      onChange={(e) => setFreeUntil(e.target.value)}
                    />
                  </Field>
                  <Field label="تعداد استفادهٔ رایگان — اختیاری">
                    <PersianNumberInput
                      className={inputClass}
                      inputMode="numeric"
                      value={freeLimit}
                      onChange={(e) => setFreeLimit(e.target.value)}
                      placeholder="مثلاً ۵۰"
                    />
                  </Field>
                </>
              )}
            </div>
            <div className="mt-3">
              <Button type="submit" disabled={busy === "feature"}>
                {busy === "feature" ? <Loader2Icon className="size-4 animate-spin" /> : "افزودن / به‌روزرسانی قابلیت"}
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              «رایگان تا تاریخ» یعنی این قابلیت تا آن تاریخ هیچ هزینه‌ای ندارد؛ «تعداد استفادهٔ رایگان» یعنی تا آن تعداد استفاده، هزینه‌ای از اعتبار کسر نمی‌شود.
            </p>
          </form>
        )}

        <div className="mt-4 space-y-2">
          {currentFeatures.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              برای این پلن هنوز قابلیتی قیمت‌گذاری نشده است.
            </p>
          )}
          {currentFeatures.map((f) => (
            <div
              key={f.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2.5"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{f.featureName ?? f.featureKey}</p>
                <p className="text-xs text-muted-foreground">
                  {MODEL_LABELS[f.pricingModel]}
                  {f.pricingModel !== "included" && f.priceRial > 0 && ` · ${toman(f.priceRial)} تومان`}
                  {f.freeUntil && ` · رایگان تا ${formatJalali(f.freeUntil, { withMonthName: true })}`}
                  {f.freeLimit != null && ` · ${toPersianDigits(f.freeLimit)} استفادهٔ رایگان`}
                </p>
              </div>
              {canManage && (
                <button
                  type="button"
                  onClick={() => void removeFeature(f)}
                  disabled={busy?.startsWith("del")}
                  className="text-red-700 dark:text-red-300 hover:text-red-800 dark:hover:text-red-200"
                  aria-label="حذف قابلیت از پلن"
                >
                  <Trash2Icon className="size-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
