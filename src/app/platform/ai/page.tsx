"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { formatToman } from "@/lib/money";
import { formatPersianNumber } from "@/lib/digits";
import {
  api,
  Button,
  Card,
  ErrorBox,
  Field,
  InfoBox,
  inputClass,
  useCan,
} from "../ui";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { PlatformSupportAssistant } from "./platform-support-assistant";

interface AiConfig {
  enabled: boolean;
  provider: "openrouter" | "arvan";
  model: string;
  baseUrl: string;
  temperature: number;
  maxOutputTokens: number;
  inputTokenRialPerMillion: number;
  outputTokenRialPerMillion: number;
  maxTurnRial: number;
  creditUnitRial: number;
  hasApiKey: boolean;
  configured: boolean;
}

interface CreditPackage {
  id: string;
  name: string;
  priceRial: number;
  creditAmountRial: number;
  isActive: boolean;
  sortOrder: number;
}

interface SubscriptionPlan {
  id: string;
  name: string;
  priceRial: number;
  monthlyCreditRial: number;
  isActive: boolean;
  sortOrder: number;
}

interface Business {
  businessId: string;
  businessName: string;
  businessStatus: string;
  balanceRial: number;
  subscriptionPlanId: string | null;
  subscriptionPlanName: string | null;
  subscriptionRenewsAt: string | null;
  usageRialLast30Days: number;
  pendingTopUps: number;
}

interface TopUp {
  id: string;
  businessId: string;
  businessName: string | null;
  packageName: string;
  priceRial: number;
  creditAmountRial: number;
  note: string | null;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
}

interface DashboardData {
  businesses: Business[];
  packages: CreditPackage[];
  subscriptions: SubscriptionPlan[];
  topUps: TopUp[];
  config: AiConfig | null;
  error?: string;
}

function fmtDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium" }).format(new Date(value));
}

function toRial(toman: string): number {
  const value = Number(toman.replace(/[٬,\s]/g, ""));
  return Number.isSafeInteger(value) && value > 0 ? value * 10 : 0;
}

export default function PlatformAiPage() {
  const can = useCan();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedBusinessId, setSelectedBusinessId] = useState("");
  const [configDraft, setConfigDraft] = useState<AiConfig | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [grantToman, setGrantToman] = useState("");
  const [grantNote, setGrantNote] = useState("");
  const [subscriptionPlanId, setSubscriptionPlanId] = useState("");
  const [packageName, setPackageName] = useState("");
  const [packagePrice, setPackagePrice] = useState("");
  const [packageCredit, setPackageCredit] = useState("");
  const [planName, setPlanName] = useState("");
  const [planPrice, setPlanPrice] = useState("");
  const [planCredit, setPlanCredit] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const result = await api<DashboardData>("/api/platform/ai");
    if (!result.ok) {
      setError(result.data.error ?? "خواندن اطلاعات هوش مصنوعی ممکن نشد.");
      setLoading(false);
      return;
    }
    setData(result.data);
    setConfigDraft(result.data.config);
    setSelectedBusinessId((current) =>
      current && result.data.businesses.some((b) => b.businessId === current)
        ? current
        : result.data.businesses[0]?.businessId ?? "",
    );
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => data?.businesses.find((business) => business.businessId === selectedBusinessId) ?? null,
    [data?.businesses, selectedBusinessId],
  );

  async function write(body: Record<string, unknown>, key: string) {
    setBusy(key);
    setError("");
    setNotice("");
    const result = await api<{ error?: string }>("/api/platform/ai", {
      method: body.action === "config" || body.action === "credit_package" || body.action === "subscription_plan" ? "PUT" : "POST",
      body: JSON.stringify(body),
    });
    setBusy("");
    if (!result.ok) {
      setError(result.data.error ?? "ذخیره‌سازی انجام نشد.");
      return false;
    }
    setNotice("تغییرات ذخیره شد.");
    await load();
    return true;
  }

  async function saveConfig(event: FormEvent) {
    event.preventDefault();
    if (!configDraft) return;
    await write(
      { action: "config", config: { ...configDraft, apiKey: apiKey || undefined } },
      "config",
    );
    setApiKey("");
  }

  async function addPackage(event: FormEvent) {
    event.preventDefault();
    if (
      await write(
        {
          action: "credit_package",
          name: packageName,
          priceRial: toRial(packagePrice),
          creditAmountRial: toRial(packageCredit),
          isActive: true,
          sortOrder: data?.packages.length ?? 0,
        },
        "package",
      )
    ) {
      setPackageName("");
      setPackagePrice("");
      setPackageCredit("");
    }
  }

  async function addPlan(event: FormEvent) {
    event.preventDefault();
    if (
      await write(
        {
          action: "subscription_plan",
          name: planName,
          priceRial: toRial(planPrice),
          monthlyCreditRial: toRial(planCredit),
          isActive: true,
          sortOrder: data?.subscriptions.length ?? 0,
        },
        "plan",
      )
    ) {
      setPlanName("");
      setPlanPrice("");
      setPlanCredit("");
    }
  }

  if (loading) {
    return <p className="text-sm text-white/50">در حال بارگذاری مدیریت هوش مصنوعی…</p>;
  }

  const businesses = data?.businesses ?? [];
  const packages = data?.packages ?? [];
  const subscriptions = data?.subscriptions ?? [];
  const topUps = data?.topUps ?? [];
  const pending = topUps.filter((request) => request.status === "pending");
  const totalBalance = businesses.reduce((total, business) => total + business.balanceRial, 0);
  const totalUsage = businesses.reduce((total, business) => total + business.usageRialLast30Days, 0);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 sm:space-y-6">
      <header>
        <h1 className="text-xl font-bold">مدیریت هوش مصنوعی</h1>
        <p className="mt-1 text-sm text-white/50">
          اتصال واحد سرویس، اعتبار کسب‌وکارها، اشتراک‌ها، درخواست‌های شارژ و مصرف سراسری.
        </p>
      </header>

      <ErrorBox>{error}</ErrorBox>
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      {can("ai.read") ? <PlatformSupportAssistant /> : null}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card title="کسب‌وکارهای AI">
          <p className="text-2xl font-bold">{formatPersianNumber(businesses.length)}</p>
        </Card>
        <Card title="اعتبار فعال">
          <p className="text-lg font-bold">{formatToman(totalBalance)}</p>
        </Card>
        <Card title="مصرف ۳۰ روز اخیر">
          <p className="text-lg font-bold">{formatToman(totalUsage)}</p>
        </Card>
        <Card title="درخواست در انتظار">
          <p className="text-2xl font-bold">{formatPersianNumber(pending.length)}</p>
        </Card>
      </section>

      {can("ai.config.manage") && configDraft ? (
        <Card title="اتصال و نرخ‌گذاری سراسری">
          <p className="mb-4 text-sm text-white/50">
            این اتصال برای همهٔ کسب‌وکارهاست. کلید API هرگز به داشبورد کسب‌وکار ارسال نمی‌شود.
          </p>
          {!configDraft.configured ? (
            <InfoBox>تا تکمیل کلید، نرخ ورودی/خروجی، سقف هر درخواست و واحد اعتبار، سرویس برای کسب‌وکارها فعال نمی‌شود.</InfoBox>
          ) : null}
          <form onSubmit={saveConfig} className="grid gap-4 lg:grid-cols-2">
            <Field label="ارائه‌دهنده">
              <SearchableSelect
                className={inputClass}
                value={configDraft.provider}
                onChange={(value) => setConfigDraft({ ...configDraft, provider: value as AiConfig["provider"] })}
                options={[
                  { value: "openrouter", label: "OpenRouter" },
                  { value: "arvan", label: "آروان‌کلاد" },
                ]}
              />
            </Field>
            <Field label="مدل">
              <input className={inputClass} dir="ltr" value={configDraft.model} onChange={(event) => setConfigDraft({ ...configDraft, model: event.target.value })} />
            </Field>
            <Field label="Base URL">
              <input className={inputClass} dir="ltr" value={configDraft.baseUrl} onChange={(event) => setConfigDraft({ ...configDraft, baseUrl: event.target.value })} />
            </Field>
            <Field label="کلید API" hint={configDraft.hasApiKey ? "کلید ذخیره شده است؛ برای حفظ آن خالی بگذارید." : "کلید سراسری را وارد کنید."}>
              <input className={inputClass} dir="ltr" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" />
            </Field>
            <Field label={"نرخ ورودی (ریال / یک‌میلیون توکن)"}>
              <input className={inputClass} type="number" min="1" value={configDraft.inputTokenRialPerMillion} onChange={(event) => setConfigDraft({ ...configDraft, inputTokenRialPerMillion: Number(event.target.value) })} />
            </Field>
            <Field label={"نرخ خروجی (ریال / یک‌میلیون توکن)"}>
              <input className={inputClass} type="number" min="1" value={configDraft.outputTokenRialPerMillion} onChange={(event) => setConfigDraft({ ...configDraft, outputTokenRialPerMillion: Number(event.target.value) })} />
            </Field>
            <Field label="حداکثر رزرو هر پاسخ (ریال)" hint="پیش از تماس با مدل رزرو می‌شود؛ باقی‌مانده پس از محاسبهٔ مصرف واقعی برمی‌گردد.">
              <input className={inputClass} type="number" min="1" value={configDraft.maxTurnRial} onChange={(event) => setConfigDraft({ ...configDraft, maxTurnRial: Number(event.target.value) })} />
            </Field>
            <Field label="هر اعتبار چند ریال است">
              <input className={inputClass} type="number" min="1" value={configDraft.creditUnitRial} onChange={(event) => setConfigDraft({ ...configDraft, creditUnitRial: Number(event.target.value) })} />
            </Field>
            <Field label="حداکثر توکن خروجی">
              <input className={inputClass} type="number" min="64" max="8192" value={configDraft.maxOutputTokens} onChange={(event) => setConfigDraft({ ...configDraft, maxOutputTokens: Number(event.target.value) })} />
            </Field>
            <Field label={"دما"}>
              <input className={inputClass} type="number" min="0" max="2" step="0.1" value={configDraft.temperature} onChange={(event) => setConfigDraft({ ...configDraft, temperature: Number(event.target.value) })} />
            </Field>
            <label className="flex items-center gap-2 text-sm text-white/80">
              <input type="checkbox" checked={configDraft.enabled} onChange={(event) => setConfigDraft({ ...configDraft, enabled: event.target.checked })} />
              فعال بودن سرویس هوش مصنوعی
            </label>
            <div className="lg:col-span-2">
              <Button type="submit" disabled={busy === "config"}>{busy === "config" ? "در حال ذخیره…" : "ذخیره اتصال و نرخ‌ها"}</Button>
            </div>
          </form>
        </Card>
      ) : null}

      {can("ai.config.manage") ? (
        <section className="grid gap-4 xl:grid-cols-2">
          <Card title="بسته‌های شارژ">
            <p className="mb-3 text-sm text-white/50">قیمت فروش و مبلغ اعتباری هر بسته به تومان وارد می‌شود؛ ذخیره‌سازی داخلی ریال است.</p>
            <ul className="mb-4 space-y-2">
              {packages.length === 0 ? <li className="text-sm text-white/40">هنوز بسته‌ای تعریف نشده است.</li> : packages.map((pkg) => (
                <li key={pkg.id} className="flex items-center justify-between rounded-lg border border-white/10 bg-white/2 p-3 text-sm">
                  <span>{pkg.name} {pkg.isActive ? null : <span className="text-white/40">— غیرفعال</span>}</span>
                  <div className="flex items-center gap-3">
                    <span className="text-white/60">{formatToman(pkg.priceRial)} ← {formatToman(pkg.creditAmountRial)} اعتبار</span>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => void write({
                        action: "credit_package",
                        id: pkg.id,
                        name: pkg.name,
                        priceRial: pkg.priceRial,
                        creditAmountRial: pkg.creditAmountRial,
                        isActive: !pkg.isActive,
                        sortOrder: pkg.sortOrder,
                      }, "package-" + pkg.id)}
                      disabled={Boolean(busy)}
                    >
                      {pkg.isActive ? "غیرفعال‌کردن" : "فعال‌کردن"}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            <form onSubmit={addPackage} className="grid gap-2 sm:grid-cols-3">
              <input className={inputClass} placeholder="نام بسته" value={packageName} onChange={(event) => setPackageName(event.target.value)} />
              <input className={inputClass} type="number" min="1" placeholder="قیمت (تومان)" value={packagePrice} onChange={(event) => setPackagePrice(event.target.value)} />
              <input className={inputClass} type="number" min="1" placeholder="اعتبار (تومان)" value={packageCredit} onChange={(event) => setPackageCredit(event.target.value)} />
              <Button type="submit" disabled={busy === "package"} className="sm:col-span-3">{busy === "package" ? "…" : "افزودن بسته"}</Button>
            </form>
          </Card>

          <Card title="اشتراک‌های ماهانه">
            <p className="mb-3 text-sm text-white/50">هر تمدید، اعتبار ماهانه را به همان موجودی واحد کسب‌وکار اضافه می‌کند.</p>
            <ul className="mb-4 space-y-2">
              {subscriptions.length === 0 ? <li className="text-sm text-white/40">هنوز اشتراکی تعریف نشده است.</li> : subscriptions.map((plan) => (
                <li key={plan.id} className="flex items-center justify-between rounded-lg border border-white/10 bg-white/2 p-3 text-sm">
                  <span>{plan.name} {plan.isActive ? null : <span className="text-white/40">— غیرفعال</span>}</span>
                  <div className="flex items-center gap-3">
                    <span className="text-white/60">{formatToman(plan.priceRial)} / {formatToman(plan.monthlyCreditRial)} اعتبار ماهانه</span>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => void write({
                        action: "subscription_plan",
                        id: plan.id,
                        name: plan.name,
                        priceRial: plan.priceRial,
                        monthlyCreditRial: plan.monthlyCreditRial,
                        isActive: !plan.isActive,
                        sortOrder: plan.sortOrder,
                      }, "plan-" + plan.id)}
                      disabled={Boolean(busy)}
                    >
                      {plan.isActive ? "غیرفعال‌کردن" : "فعال‌کردن"}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            <form onSubmit={addPlan} className="grid gap-2 sm:grid-cols-3">
              <input className={inputClass} placeholder="نام اشتراک" value={planName} onChange={(event) => setPlanName(event.target.value)} />
              <input className={inputClass} type="number" min="1" placeholder="قیمت ماهانه (تومان)" value={planPrice} onChange={(event) => setPlanPrice(event.target.value)} />
              <input className={inputClass} type="number" min="1" placeholder="اعتبار ماهانه (تومان)" value={planCredit} onChange={(event) => setPlanCredit(event.target.value)} />
              <Button type="submit" disabled={busy === "plan"} className="sm:col-span-3">{busy === "plan" ? "…" : "افزودن اشتراک"}</Button>
            </form>
          </Card>
        </section>
      ) : null}

      <Card title="کنترل کسب‌وکار">
        <div className="mb-4 grid gap-3 md:grid-cols-2">
          <Field label="کسب‌وکار">
            <SearchableSelect
              value={selectedBusinessId}
              onChange={setSelectedBusinessId}
              options={businesses.map((business) => ({
                value: business.businessId,
                label: business.businessName,
              }))}
            />
          </Field>
          {selected ? (
            <div className="rounded-lg border border-white/10 bg-white/2 p-3 text-sm text-white/70">
              <p>مانده: <strong className="text-white">{formatToman(selected.balanceRial)}</strong></p>
              <p className="mt-1">مصرف ۳۰ روز: {formatToman(selected.usageRialLast30Days)}</p>
              <p className="mt-1">اشتراک: {selected.subscriptionPlanName ?? "ندارد"}</p>
            </div>
          ) : null}
        </div>
        {selected && can("ai.credits.manage") ? (
          <div className="grid gap-4 border-t border-white/10 pt-4 lg:grid-cols-3">
            <div>
              <p className="mb-2 text-sm font-medium">فعال‌سازی ویژگی</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" onClick={() => void write({ action: "feature", businessId: selected.businessId, enabled: true }, "feature-on")} disabled={Boolean(busy)}>فعال</Button>
                <Button variant="ghost" onClick={() => void write({ action: "feature", businessId: selected.businessId, enabled: false }, "feature-off")} disabled={Boolean(busy)}>غیرفعال</Button>
                <Button variant="ghost" onClick={() => void write({ action: "feature", businessId: selected.businessId, enabled: null }, "feature-default")} disabled={Boolean(busy)}>پیش‌فرض</Button>
              </div>
            </div>
            <form onSubmit={(event) => { event.preventDefault(); void write({ action: "grant", businessId: selected.businessId, amountRial: toRial(grantToman), note: grantNote }, "grant"); }} className="space-y-2">
              <p className="text-sm font-medium">اعطای اعتبار دستی</p>
              <input className={inputClass} type="number" min="1" placeholder="اعتبار (تومان)" value={grantToman} onChange={(event) => setGrantToman(event.target.value)} />
              <input className={inputClass} placeholder="یادداشت (اختیاری)" value={grantNote} onChange={(event) => setGrantNote(event.target.value)} />
              <Button type="submit" disabled={busy === "grant"}>{busy === "grant" ? "…" : "افزودن اعتبار"}</Button>
            </form>
            <form onSubmit={(event) => { event.preventDefault(); void write({ action: "subscription", businessId: selected.businessId, subscriptionPlanId: subscriptionPlanId || null }, "subscription"); }} className="space-y-2">
              <p className="text-sm font-medium">اشتراک</p>
              <SearchableSelect
                value={subscriptionPlanId}
                onChange={setSubscriptionPlanId}
                options={[
                  { value: "", label: "بدون اشتراک" },
                  ...subscriptions
                    .filter((plan) => plan.isActive)
                    .map((plan) => ({ value: plan.id, label: plan.name })),
                ]}
              />
              <Button type="submit" disabled={busy === "subscription"}>{busy === "subscription" ? "…" : "ثبت اشتراک"}</Button>
            </form>
          </div>
        ) : null}
      </Card>

      <Card title="درخواست‌های شارژ">
        {topUps.length === 0 ? <p className="text-sm text-white/50">درخواستی ثبت نشده است.</p> : (
          <ul className="space-y-2">
            {topUps.map((request) => (
              <li key={request.id} className="flex flex-col gap-3 rounded-lg border border-white/10 bg-white/2 p-3 text-sm md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="font-medium">{request.businessName} — {request.packageName}</p>
                  <p className="mt-1 text-xs text-white/50">{formatToman(request.priceRial)} برای {formatToman(request.creditAmountRial)} اعتبار · {fmtDate(request.createdAt)}</p>
                  {request.note ? <p className="mt-1 text-xs text-white/40">{request.note}</p> : null}
                </div>
                {request.status === "pending" && can("ai.credits.manage") ? (
                  <div className="flex gap-2">
                    <Button onClick={() => void write({ action: "top_up_review", requestId: request.id, status: "approved" }, request.id + "-approve")} disabled={Boolean(busy)}>تأیید</Button>
                    <Button variant="danger" onClick={() => void write({ action: "top_up_review", requestId: request.id, status: "rejected" }, request.id + "-reject")} disabled={Boolean(busy)}>رد</Button>
                  </div>
                ) : <span className="text-xs text-white/50">{request.status === "approved" ? "تأیید شده" : request.status === "rejected" ? "رد شده" : "در انتظار"}</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
