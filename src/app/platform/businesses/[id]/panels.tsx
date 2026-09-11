"use client";

/**
 * The business workspace's panels, split out of the old single-page console
 * view so each section page composes two or three of them instead of one
 * thousand-line scroll. Every panel reads (and saves through) the shared
 * `useBusiness()` context, so a write in one section refreshes the identity
 * header and the sidebar without a remount.
 */
import { useCallback, useEffect, useState } from "react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { formatPersianNumber } from "@/lib/digits";
import { validateSubdomain } from "@/lib/slug";
import { INDUSTRY_LABELS, type Industry } from "@/lib/industries";
import {
  api,
  errorMessage,
  ErrorBox,
  InfoBox,
  Field,
  Button,
  Card,
  inputClass,
  useCan,
  SkeletonRows,
} from "../../ui";
import { IndustryPicker } from "../../industry-picker";
import { useBusiness } from "./context";

/**
 * Name + timezone. The workspace header shows who this is; this card is the
 * ordinary metadata edit — deliberately kept separate from subdomain and
 * industry, which each carry their own confirmation and side effects.
 */
export function BusinessDetailsPanel() {
  const { business, reload } = useBusiness();
  const can = useCan();
  const editable = can("business.edit");
  const [name, setName] = useState(business?.name ?? "");
  const [timezone, setTimezone] = useState(business?.timezone ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!business) return;
    setName(business.name);
    setTimezone(business.timezone);
  }, [business?.id, business?.name, business?.timezone]);

  if (!business) return null;
  const changed = name.trim() !== business.name || timezone.trim() !== business.timezone;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const { ok, data } = await api<{ error?: string }>(`/api/platform/businesses/${business!.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: name.trim(), timezone: timezone.trim() }),
    });
    setBusy(false);
    if (ok) {
      setSaved(true);
      void reload();
    } else {
      setError(errorMessage(data.error));
    }
  }

  return (
    <Card title="ویرایش کسب‌وکار">
      <ErrorBox>{error}</ErrorBox>
      {saved ? <InfoBox>اطلاعات کسب‌وکار ذخیره شد.</InfoBox> : null}
      <form onSubmit={save} className="grid gap-x-4 sm:grid-cols-2">
        <Field label="نام کسب‌وکار">
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!editable}
            className={inputClass}
          />
        </Field>
        <Field label="منطقهٔ زمانی" hint="مانند Asia/Tehran">
          <input
            required
            dir="ltr"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            disabled={!editable}
            className={inputClass}
          />
        </Field>
        <div className="mb-4 min-w-0">
          <p className="mb-1 text-sm font-medium text-foreground">شناسهٔ کسب‌وکار</p>
          <p
            className="break-all rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground"
            dir="ltr"
          >
            {business.slug}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">این شناسه برای پایداری ارجاع‌ها تغییر نمی‌کند.</p>
        </div>
        {editable ? (
          <div className="mb-4 flex items-end sm:justify-end">
            <Button type="submit" disabled={busy || !changed} className="w-full sm:w-auto">
              {busy ? "در حال ذخیره…" : "ذخیرهٔ تغییرات"}
            </Button>
          </div>
        ) : null}
      </form>
    </Card>
  );
}

/**
 * Phase 25 Wave 1 — change which industry a business operates in.
 *
 * Migration 0048 made `industry` immutable *by omission*: no update route
 * existed, because the chart of accounts is seeded from it at creation and
 * there was no way to reconcile a switch. This panel is the deliberate
 * reversal of that, so a mis-provisioned tenant does not need a factory reset.
 *
 * What it cannot do is rewrite history, and it says so rather than implying
 * otherwise: seeding is additive, the old industry's rows stay in place but
 * become unreachable, and the counts below are the server's real numbers so
 * the admin confirms against facts instead of a generic warning.
 */
export function IndustryPanel() {
  const { business, industryCounts, reload } = useBusiness();
  const can = useCan();
  const editable = can("business.edit");
  const [industry, setIndustry] = useState<Industry>(business?.industry ?? "food_service");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSaved(null);
    if (business) setIndustry(business.industry);
  }, [business?.id, business?.industry]);

  if (!business) return null;
  const changed = industry !== business.industry;
  const counts = industryCounts;
  const carried = counts
    ? [
        { label: "آیتم منو", value: counts.menuItems },
        { label: "کالای صنفی", value: counts.industryItems },
        { label: "سفارش", value: counts.orders },
        { label: "سند حسابداری", value: counts.journalEntries },
      ].filter((c) => c.value > 0)
    : [];

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const warning =
      carried.length > 0
        ? "\n\nاین کسب‌وکار داده‌ای دارد که به نوع فعلی تعلق دارد:\n" +
          carried.map((c) => `• ${c.label}: ${formatPersianNumber(c.value)}`).join("\n") +
          "\n\nاین داده‌ها حذف نمی‌شوند، اما پس از تغییر نوع، دیگر از داشبورد در دسترس نخواهند بود. " +
          "سرفصل‌های حساب موجود هم دست‌نخورده می‌مانند و فقط حساب‌های نبودهٔ نوع جدید اضافه می‌شوند."
        : "";
    if (
      !window.confirm(
        `نوع «${business!.name}» از «${INDUSTRY_LABELS[business!.industry]}» به «${INDUSTRY_LABELS[industry]}» تغییر کند؟` +
          warning,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(null);
    const { ok, data } = await api<{ seededAccountCodes?: string[]; error?: string }>(
      `/api/platform/businesses/${business!.id}`,
      { method: "PATCH", body: JSON.stringify({ industry }) },
    );
    setBusy(false);
    if (ok) {
      const seeded = data.seededAccountCodes?.length ?? 0;
      setSaved(
        seeded > 0
          ? `نوع کسب‌وکار تغییر کرد و ${formatPersianNumber(seeded)} سرفصل حساب جدید اضافه شد.`
          : "نوع کسب‌وکار تغییر کرد. سرفصل حساب جدیدی لازم نبود.",
      );
      void reload();
    } else {
      setError(errorMessage(data.error));
    }
  }

  return (
    <Card title="نوع کسب‌وکار">
      <ErrorBox>{error}</ErrorBox>
      {saved ? <InfoBox>{saved}</InfoBox> : null}
      <form onSubmit={save}>
        <p className="mb-3 text-sm text-muted-foreground">
          نوع فعلی:{" "}
          <span className="font-medium text-foreground">{INDUSTRY_LABELS[business.industry]}</span>
        </p>
        <IndustryPicker value={industry} onChange={setIndustry} disabled={!editable || busy} />
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          نوع کسب‌وکار تعیین می‌کند چه سرفصل حساب‌هایی ساخته می‌شود، مالک چه مراحلی از راه‌اندازی را
          می‌بیند، و داشبورد کدام ماژول‌ها را نشان می‌دهد.
        </p>
        {changed && carried.length > 0 ? (
          <div className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2.5 text-xs leading-6 text-amber-800/90 dark:text-amber-200/90">
            <p className="font-medium">این کسب‌وکار داده‌ای دارد که به نوع فعلی تعلق دارد:</p>
            <ul className="mt-1 space-y-0.5">
              {carried.map((c) => (
                <li key={c.label}>
                  {c.label}: {formatPersianNumber(c.value)}
                </li>
              ))}
            </ul>
            <p className="mt-1.5">
              چیزی حذف نمی‌شود؛ اما این داده‌ها پس از تغییر از داشبورد در دسترس نخواهند بود.
            </p>
          </div>
        ) : null}
        {editable ? (
          <div className="mt-4">
            <Button type="submit" disabled={busy || !changed}>
              {busy ? "در حال تغییر…" : "تغییر نوع کسب‌وکار"}
            </Button>
          </div>
        ) : null}
      </form>
    </Card>
  );
}

/**
 * Phase 23 — the business's public host.
 *
 * Renaming an origin is not an ordinary metadata edit: it writes the old name
 * into `business_subdomain_aliases` so existing links keep resolving, and it
 * invalidates every live session on the old host. The admin is told that
 * before they confirm, not after.
 */
export function SubdomainPanel() {
  const { business, rootDomain, aliases, reload } = useBusiness();
  const can = useCan();
  const editable = can("business.edit");
  const [subdomain, setSubdomain] = useState(business?.subdomain ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (business) setSubdomain(business.subdomain);
    setSaved(false);
  }, [business?.id, business?.subdomain]);

  if (!business) return null;
  const trimmed = subdomain.trim().toLowerCase();
  const invalid = trimmed ? validateSubdomain(trimmed) : "invalid_subdomain";
  const changed = trimmed !== business.subdomain.toLowerCase();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (
      !window.confirm(
        `نشانی این کسب‌وکار به «${trimmed}» تغییر کند؟\n\n` +
          "نشانی قبلی همچنان به نشانی جدید هدایت می‌شود، اما نشست‌های بازِ کاربران روی نشانی قبلی " +
          "باطل می‌شود و باید دوباره وارد شوند.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    const { ok, data } = await api<{ error?: string }>(`/api/platform/businesses/${business!.id}`, {
      method: "PATCH",
      body: JSON.stringify({ subdomain: trimmed }),
    });
    setBusy(false);
    if (ok) {
      setSaved(true);
      void reload();
    } else {
      setError(errorMessage(data.error));
    }
  }

  return (
    <Card title="نشانی اینترنتی">
      <ErrorBox>{error}</ErrorBox>
      {saved ? <InfoBox>نشانی تغییر کرد. نشانی قبلی به نشانی جدید هدایت می‌شود.</InfoBox> : null}
      <form onSubmit={save}>
        <Field
          label="زیردامنه"
          hint={
            invalid ? undefined : rootDomain
              ? `https://${trimmed}.${rootDomain}`
              : "فقط حروف انگلیسی کوچک، رقم و خط تیره."
          }
        >
          <input
            dir="ltr"
            value={subdomain}
            onChange={(e) => setSubdomain(e.target.value)}
            disabled={!editable}
            className={`${inputClass} text-start`}
          />
          {invalid && changed ? (
            <span className="mt-1 block text-xs text-rose-700 dark:text-rose-300">{errorMessage(invalid)}</span>
          ) : null}
        </Field>

        {aliases.length > 0 ? (
          <div className="mb-4">
            <p className="mb-1 text-sm font-medium text-foreground">نشانی‌های قبلی</p>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {aliases.map((a) => (
                <li key={a.alias} dir="ltr">
                  {rootDomain ? `${a.alias}.${rootDomain}` : a.alias}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-muted-foreground">
              این نشانی‌ها همچنان کار می‌کنند و به نشانی فعلی هدایت می‌شوند.
            </p>
          </div>
        ) : null}

        {editable ? (
          <Button type="submit" disabled={busy || !changed || Boolean(invalid)}>
            {busy ? "در حال تغییر…" : "تغییر نشانی"}
          </Button>
        ) : null}
      </form>
    </Card>
  );
}

/** Persian-digit limit, or "نامحدود" (unlimited) for a null ceiling. */
function limitLabel(n: number | null): string {
  return n === null ? "نامحدود" : formatPersianNumber(n);
}

interface Plan {
  key: string;
  name: string;
  branchLimit: number | null;
  memberLimit: number | null;
  monthlyOrderLimit: number | null;
}

export function PlanPanel() {
  const { business, reload } = useBusiness();
  const can = useCan();
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [plan, setPlan] = useState(business?.plan ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const editable = can("features.write");

  useEffect(() => {
    void api<{ plans: Plan[] }>("/api/platform/plans")
      .then(({ ok, data }) => setPlans(ok ? data.plans : []))
      .catch(() => setPlans([]));
  }, []);

  useEffect(() => {
    if (business) setPlan(business.plan);
  }, [business?.id, business?.plan]);

  if (!business) return null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const { ok, data } = await api<{ error?: string }>(`/api/platform/businesses/${business!.id}`, {
      method: "PATCH",
      body: JSON.stringify({ plan }),
    });
    setBusy(false);
    if (ok) {
      setSaved(true);
      void reload();
    } else {
      setError(errorMessage(data.error));
    }
  }

  if (plans === null) {
    return (
      <Card title="پلن اشتراک">
        <SkeletonRows rows={3} label="در حال بارگذاری پلن‌ها" />
      </Card>
    );
  }

  const current = plans.find((p) => p.key === plan);

  return (
    <Card title="پلن اشتراک">
      <ErrorBox>{error}</ErrorBox>
      {saved ? <InfoBox>پلن ذخیره شد.</InfoBox> : null}
      <form onSubmit={save} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <Field label="پلن">
            <SearchableSelect
              value={plan}
              onChange={setPlan}
              disabled={!editable || plans.length === 0}
              className={inputClass}
              ariaLabel="پلن اشتراک"
              options={[
                // The business's current plan key always appears, even if it
                // somehow isn't in the fetched catalogue yet.
                ...(!plans.some((p) => p.key === business.plan)
                  ? [{ value: business.plan, label: business.plan }]
                  : []),
                ...plans.map((p) => ({
                  value: p.key,
                  label: `${p.name} (شعبه: ${limitLabel(p.branchLimit)}، عضو: ${limitLabel(p.memberLimit)}، سفارش ماهانه: ${limitLabel(p.monthlyOrderLimit)})`,
                })),
              ]}
            />
          </Field>
          {current ? (
            <p className="mt-1 text-xs text-muted-foreground">
              سقف فعلی: {limitLabel(current.branchLimit)} شعبه، {limitLabel(current.memberLimit)} عضو،{" "}
              {limitLabel(current.monthlyOrderLimit)} سفارش در ماه.
            </p>
          ) : null}
        </div>
        {editable ? (
          <div className="mb-4 w-full sm:w-auto">
            <Button type="submit" disabled={busy || plan === business.plan} className="w-full sm:w-auto">
              {busy ? "…" : "ذخیره"}
            </Button>
          </div>
        ) : null}
      </form>
    </Card>
  );
}

interface Usage {
  orders: number;
  openOrders: number;
  members: number;
  locations: number;
  menuItems: number;
  journalEntries: number;
  lastActivity: string | null;
}

/** Real usage figures against the plan's ceilings; also feeds the overview. */
export function UsagePanel() {
  const { business, version } = useBusiness();
  const [usage, setUsage] = useState<Usage | null>(null);

  const load = useCallback(async () => {
    if (!business) return;
    const { ok, data } = await api<{ usage: Usage }>(
      `/api/platform/businesses/${business.id}/usage`,
    );
    if (ok) setUsage(data.usage);
  }, [business?.id, version]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!business) return null;

  if (!usage) {
    return (
      <Card title="مصرف و فعالیت">
        <SkeletonRows rows={3} />
      </Card>
    );
  }

  const stats: { label: string; value: string }[] = [
    { label: "سفارش‌ها", value: formatPersianNumber(usage.orders) },
    { label: "سفارش‌های باز", value: formatPersianNumber(usage.openOrders) },
    { label: "اعضای فعال", value: formatPersianNumber(usage.members) },
    { label: "شعبه‌ها", value: formatPersianNumber(usage.locations) },
    { label: "اقلام منو", value: formatPersianNumber(usage.menuItems) },
    { label: "اسناد دفتر کل", value: formatPersianNumber(usage.journalEntries) },
  ];

  return (
    <Card title="مصرف و فعالیت">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {stats.map((s) => (
          <div key={s.label} className="rounded-lg border border-border bg-card p-3">
            <p className="text-xs text-muted-foreground">{s.label}</p>
            <p className="mt-1 text-lg font-bold tabular-nums">{s.value}</p>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        آخرین فعالیت: {usage.lastActivity ? new Date(usage.lastActivity).toLocaleString("fa-IR") : "—"}
      </p>
    </Card>
  );
}

interface Feature {
  key: string;
  name: string;
  description: string | null;
  defaultEnabled: boolean;
  override: boolean | null;
  effective: boolean;
}

export function FeaturesPanel() {
  const { business, version } = useBusiness();
  const can = useCan();
  const editable = can("features.write");
  const [features, setFeatures] = useState<Feature[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!business) return;
    const { ok, data } = await api<{ features: Feature[]; error?: string }>(
      `/api/platform/businesses/${business.id}/features`,
    );
    if (ok) setFeatures(data.features);
    else setError(errorMessage(data.error));
  }, [business?.id, version]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!business) return null;
  const bizId = business.id;

  async function setOverride(flagKey: string, enabled: boolean | null) {
    setPending(flagKey);
    setError(null);
    const { ok, data } = await api<{ features: Feature[]; error?: string }>(
      `/api/platform/businesses/${bizId}/features`,
      { method: "PATCH", body: JSON.stringify({ flagKey, enabled }) },
    );
    setPending(null);
    if (ok) setFeatures(data.features);
    else setError(errorMessage(data.error));
  }

  return (
    <Card title="پرچم‌های ویژگی">
      <ErrorBox>{error}</ErrorBox>
      {features === null ? (
        <SkeletonRows rows={3} />
      ) : features.length === 0 ? (
        <p className="text-sm text-muted-foreground">پرچمی تعریف نشده است.</p>
      ) : (
        <div className="space-y-2">
          {features.map((f) => (
            <div
              key={f.key}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">{f.name}</p>
                {f.description ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">{f.description}</p>
                ) : null}
                <p className="mt-1 text-xs text-muted-foreground" dir="ltr">
                  {f.key}
                </p>
              </div>
              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
                <span
                  className={
                    f.effective
                      ? "rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-300"
                      : "rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                  }
                >
                  {f.effective ? "فعال" : "غیرفعال"}
                </span>
                <span className="text-xs text-muted-foreground">
                  {f.override === null
                    ? `پیش‌فرض (${f.defaultEnabled ? "روشن" : "خاموش"})`
                    : "بازنویسی‌شده"}
                </span>
                {editable ? (
                  <div className="flex flex-wrap gap-1">
                    <button
                      type="button"
                      disabled={pending === f.key}
                      onClick={() => setOverride(f.key, true)}
                      className="rounded-lg border border-border px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50"
                    >
                      روشن
                    </button>
                    <button
                      type="button"
                      disabled={pending === f.key}
                      onClick={() => setOverride(f.key, false)}
                      className="rounded-lg border border-border px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50"
                    >
                      خاموش
                    </button>
                    <button
                      type="button"
                      disabled={pending === f.key || f.override === null}
                      onClick={() => setOverride(f.key, null)}
                      className="rounded-lg border border-border px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50"
                    >
                      پیش‌فرض
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

interface Grant {
  id: string;
  platformAdminId: string;
  mode: "read_only" | "full";
  reason: string | null;
  createdAt: string;
  expiresAt: string;
  endedAt: string | null;
  revokedAt: string | null;
}

export function ImpersonationPanel() {
  const { business, setNotice, version } = useBusiness();
  const can = useCan();
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!business) return;
    const { ok, data } = await api<{ grants: Grant[]; error?: string }>(
      `/api/platform/impersonation?businessId=${business.id}`,
    );
    if (ok) setGrants(data.grants);
    else setError(errorMessage(data.error));
  }, [business?.id, version]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!business) return null;

  async function enter(mode: "read_only" | "full") {
    const label = mode === "full" ? "دسترسی کامل" : "فقط‌خواندنی";
    if (!window.confirm(`ورود به «${business!.name}» با ${label}؟ این اقدام ثبت می‌شود.`)) return;
    setBusy(true);
    setError(null);
    const { ok, data } = await api<{ handoffUrl?: string; error?: string }>(
      `/api/platform/businesses/${business!.id}/impersonate`,
      { method: "POST", body: JSON.stringify({ mode, reason: reason.trim() || undefined }) },
    );
    setBusy(false);
    if (ok) {
      // Host-routed deployments mint the session on the business's own origin,
      // so the console hands the browser a one-time URL to follow there; a
      // single-host install mints the cookie here and navigates straight in.
      window.location.href = data.handoffUrl ?? "/dashboard";
    } else {
      setError(errorMessage(data.error));
    }
  }

  async function revoke(grantId: string) {
    if (!window.confirm("این نشست پشتیبانی لغو شود؟")) return;
    const { ok, data } = await api<{ error?: string }>(
      `/api/platform/impersonation/${grantId}?action=revoke`,
      { method: "DELETE" },
    );
    if (ok) {
      setNotice("نشست پشتیبانی لغو شد.");
      void load();
    } else setError(errorMessage(data.error));
  }

  function grantState(g: Grant): { label: string; cls: string } {
    if (g.revokedAt) return { label: "لغو‌شده", cls: "text-red-700 dark:text-red-300" };
    if (g.endedAt) return { label: "پایان‌یافته", cls: "text-muted-foreground" };
    if (new Date(g.expiresAt).getTime() <= Date.now())
      return { label: "منقضی", cls: "text-muted-foreground" };
    return { label: "باز", cls: "text-emerald-700 dark:text-emerald-300" };
  }

  const canReadOnly = can("impersonate.readOnly");
  const canFull = can("impersonate.full");
  const canRevoke = can("impersonate.revoke");
  const openGrants = (grants ?? []).filter((g) => grantState(g).label === "باز");

  return (
    <Card title="دسترسی پشتیبانی">
      <ErrorBox>{error}</ErrorBox>

      {openGrants.length > 0 ? (
        <div className="mb-3 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-200">
          {formatPersianNumber(openGrants.length)} نشست پشتیبانی هم‌اکنون باز است. پیش از بستن
          مرورگر، آن را ببندید یا لغو کنید.
        </div>
      ) : null}

      {canReadOnly || canFull ? (
        <div className="mb-4 rounded-lg border border-border bg-card p-3">
          <Field label="دلیل (اختیاری، در گزارش ثبت می‌شود)">
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className={inputClass}
              placeholder="مثلاً: بررسی مشکل چاپ رسید"
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            {canReadOnly ? (
              <Button variant="ghost" onClick={() => void enter("read_only")} disabled={busy}>
                ورود فقط‌خواندنی
              </Button>
            ) : null}
            {canFull ? (
              <Button variant="danger" onClick={() => void enter("full")} disabled={busy}>
                ورود با دسترسی کامل
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {grants === null ? (
        <SkeletonRows rows={3} />
      ) : grants.length === 0 ? (
        <p className="text-sm text-muted-foreground">هنوز دسترسی پشتیبانی ثبت نشده است.</p>
      ) : (
        <div className="space-y-2">
          {grants.map((g) => {
            const st = grantState(g);
            const open = st.label === "باز";
            return (
              <div
                key={g.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card p-3 text-sm"
              >
                <div>
                  <span className="font-medium">
                    {g.mode === "full" ? "دسترسی کامل" : "فقط‌خواندنی"}
                  </span>
                  <span className={`ms-2 text-xs ${st.cls}`}>{st.label}</span>
                  {g.reason ? <p className="mt-0.5 text-xs text-muted-foreground">{g.reason}</p> : null}
                  <p className="mt-0.5 text-xs text-muted-foreground" dir="ltr">
                    {new Date(g.createdAt).toLocaleString("fa-IR")} ←{" "}
                    {new Date(g.expiresAt).toLocaleString("fa-IR")}
                  </p>
                </div>
                {open && canRevoke ? (
                  <button
                    type="button"
                    onClick={() => void revoke(g.id)}
                    className="rounded-lg border border-red-500/30 px-2 py-1 text-xs text-red-700 dark:text-red-300 hover:bg-red-500/10"
                  >
                    لغو
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/**
 * Both reset and remove are immediate and irreversible with no other safety
 * net (no archive step, no grace window), so both are confirmed by typing
 * this same fixed phrase rather than the business's own (often Persian, so
 * tedious to retype exactly) slug. Must match `DESTRUCTIVE_CONFIRMATION_PHRASE`
 * in src/lib/platform-admin.ts, which the server actually enforces.
 */
const CONFIRMATION_PHRASE = "delete-me";

export function ResetPanel() {
  const { business, reload, setNotice } = useBusiness();
  const can = useCan();
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!business || !can("business.reset")) return null;

  async function reset() {
    if (
      !window.confirm(
        `همهٔ داده‌های «${business!.name}» حذف شود و کسب‌وکار از ابتدا راه‌اندازی شود؟ این عمل برگشت‌ناپذیر است.`,
      )
    ) {
      return;
    }

    setBusy(true);
    setError(null);
    const { ok, data } = await api<{ error?: string }>(`/api/platform/businesses/${business!.id}`, {
      method: "POST",
      body: JSON.stringify({ confirmation }),
    });
    setBusy(false);
    if (ok) {
      setConfirmation("");
      setNotice("داده‌های کسب‌وکار پاک شد. مالک باید دوباره وارد شود و راه‌اندازی اولیه را انجام دهد.");
      void reload();
    } else {
      setError(errorMessage(data.error));
    }
  }

  return (
    <Card title="ریست کامل داده‌ها">
      <ErrorBox>{error}</ErrorBox>
      <div className="rounded-lg border border-red-500/25 bg-red-500/8 p-3 text-sm text-red-900 dark:text-red-100">
        <p className="font-semibold">همهٔ داده‌های این کسب‌وکار حذف می‌شوند.</p>
        <p className="mt-1 text-red-900/70 dark:text-red-100/70">
          سفارش‌ها، انبار، حسابداری، تنظیمات، شعبه‌ها، کاربران و دسترسی‌های ویژگی پاک می‌شوند. تنها
          هویت سراسری مالک و پلن کسب‌وکار باقی می‌ماند تا راه‌اندازی از ابتدا انجام شود.
        </p>
      </div>
      <div className="mt-4">
        <Field label={`برای تأیید، عبارت زیر را دقیق وارد کنید: ${CONFIRMATION_PHRASE}`}>
          <input
            dir="ltr"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            className={inputClass}
            placeholder={CONFIRMATION_PHRASE}
            autoComplete="off"
          />
        </Field>
        <Button
          variant="danger"
          onClick={reset}
          disabled={busy || confirmation.trim() !== CONFIRMATION_PHRASE}
          className="w-full sm:w-auto"
        >
          {busy ? "در حال ریست…" : "حذف داده‌ها و شروع مجدد"}
        </Button>
      </div>
    </Card>
  );
}

export function RemovePanel() {
  const { business } = useBusiness();
  const can = useCan();
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!business || !can("business.delete")) return null;

  async function remove() {
    if (
      !window.confirm(`«${business!.name}» برای همیشه حذف شود؟ این عمل قطعی و بازگشت‌ناپذیر است.`)
    ) {
      return;
    }

    setBusy(true);
    setError(null);
    const { ok, data } = await api<{ error?: string }>(`/api/platform/businesses/${business!.id}`, {
      method: "DELETE",
      body: JSON.stringify({ confirmation }),
    });
    if (ok) {
      window.location.href = "/platform";
      return;
    }
    setBusy(false);
    setError(errorMessage(data.error));
  }

  return (
    <Card title="حذف کسب‌وکار">
      <ErrorBox>{error}</ErrorBox>
      <div className="rounded-lg border border-red-500/25 bg-red-500/8 p-3 text-sm text-red-900 dark:text-red-100">
        <p className="font-semibold">این کسب‌وکار برای همیشه حذف می‌شود.</p>
        <p className="mt-1 text-red-900/70 dark:text-red-100/70">
          فوری و قطعی است — بدون بایگانی و بدون مهلت. همهٔ داده‌ها، کاربران، شعبه‌ها و اطلاعات
          کسب‌وکار از بین می‌روند.
        </p>
      </div>
      <div className="mt-4">
        <Field label={`برای تأیید، عبارت زیر را دقیق وارد کنید: ${CONFIRMATION_PHRASE}`}>
          <input
            dir="ltr"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            className={inputClass}
            placeholder={CONFIRMATION_PHRASE}
            autoComplete="off"
          />
        </Field>
        <Button
          variant="danger"
          onClick={remove}
          disabled={busy || confirmation.trim() !== CONFIRMATION_PHRASE}
          className="w-full sm:w-auto"
        >
          {busy ? "در حال حذف…" : "حذف قطعی کسب‌وکار"}
        </Button>
      </div>
    </Card>
  );
}
