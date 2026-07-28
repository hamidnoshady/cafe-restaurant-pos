"use client";

/**
 * Phase 15 — one business, everything an operator can do to it.
 *
 * Lifecycle controls (suspend / reactivate / archive / hard-delete), plan
 * assignment, feature-flag overrides, a usage snapshot, and support access
 * (impersonation) with its live grant list. Every control is gated on the
 * admin's capabilities via `useCan`, matching the server guards — the server
 * still re-checks, this only hides what the operator couldn't use.
 */
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { toPersianDigits, formatPersianNumber } from "@/lib/digits";
import {
  api,
  errorMessage,
  ErrorBox,
  InfoBox,
  Field,
  Button,
  Card,
  StatusBadge,
  inputClass,
  useCan,
} from "../../ui";

interface Business {
  id: string;
  name: string;
  slug: string;
  status: string;
  plan: string;
  timezone: string;
  createdAt: string;
  suspendedAt: string | null;
  archivedAt: string | null;
  locationCount: number;
  memberCount: number;
}

interface Feature {
  key: string;
  name: string;
  description: string | null;
  defaultEnabled: boolean;
  override: boolean | null;
  effective: boolean;
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

interface Plan {
  key: string;
  name: string;
  branchLimit: number | null;
  memberLimit: number | null;
  monthlyOrderLimit: number | null;
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

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return toPersianDigits(
      new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(iso),
      ),
    );
  } catch {
    return iso;
  }
}

export default function BusinessDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const can = useCan();

  const [business, setBusiness] = useState<Business | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);

  const loadBusiness = useCallback(async () => {
    const { ok, data } = await api<{ business: Business; error?: string }>(
      `/api/platform/businesses/${id}`,
    );
    if (ok) setBusiness(data.business);
    else setError(errorMessage(data.error));
  }, [id]);

  useEffect(() => {
    void loadBusiness();
  }, [loadBusiness]);

  async function changeStatus(status: string, label: string) {
    if (!confirm(`«${business?.name}» به وضعیت ${label} تغییر کند؟`)) return;
    setError(null);
    setNotice(null);
    const { ok, data } = await api<{ error?: string }>(`/api/platform/businesses/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    if (ok) {
      setNotice("وضعیت به‌روزرسانی شد.");
      void loadBusiness();
    } else {
      setError(errorMessage(data.error));
    }
  }

  if (!business) {
    return (
      <div className="mx-auto max-w-4xl">
        <ErrorBox>{error}</ErrorBox>
        {!error ? <p className="text-sm text-white/50">در حال بارگذاری…</p> : null}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 sm:space-y-6">
      <div>
        <Link href="/platform" className="text-sm text-sky-300 hover:underline">
          ← بازگشت به فهرست
        </Link>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-bold">{business.name}</h1>
          <StatusBadge status={business.status} />
          <span className="text-xs text-white/30" dir="ltr">
            {business.slug}
          </span>
        </div>
      </div>

      <ErrorBox>{error}</ErrorBox>
      <InfoBox>{notice}</InfoBox>

      {/* Lifecycle */}
      <Card title="چرخهٔ حیات">
        <dl className="mb-4 grid gap-3 text-sm sm:grid-cols-2">
          <Meta label="منطقهٔ زمانی" value={business.timezone} ltr />
          <Meta label="ایجاد" value={fmtDate(business.createdAt)} />
          <Meta label="تعلیق در" value={fmtDate(business.suspendedAt)} />
          <Meta label="بایگانی در" value={fmtDate(business.archivedAt)} />
        </dl>
        <div className="flex flex-wrap gap-2">
          {business.status === "active" && can("business.suspend") ? (
            <Button variant="ghost" onClick={() => changeStatus("suspended", "معلق")}>
              تعلیق
            </Button>
          ) : null}
          {business.status === "suspended" && can("business.suspend") ? (
            <Button onClick={() => changeStatus("active", "فعال")}>فعال‌سازی مجدد</Button>
          ) : null}
          {business.status !== "archived" && can("business.archive") ? (
            <Button variant="ghost" onClick={() => changeStatus("archived", "بایگانی")}>
              بایگانی
            </Button>
          ) : null}
          {business.status === "archived" && can("business.suspend") ? (
            <Button onClick={() => changeStatus("active", "فعال")}>بازگردانی از بایگانی</Button>
          ) : null}
        </div>
      </Card>

      <BusinessDetailsPanel business={business} onChanged={loadBusiness} />
      <PlanPanel key={`plan-${resetKey}`} business={business} onChanged={loadBusiness} />
      <UsagePanel key={`usage-${resetKey}`} id={id} />
      <FeaturesPanel key={`features-${resetKey}`} id={id} />
      <ImpersonationPanel key={`impersonation-${resetKey}`} id={id} businessName={business.name} />
      <ResetPanel
        business={business}
        onChanged={() => {
          setNotice("داده‌های کسب‌وکار پاک شد. مالک باید دوباره وارد شود و راه‌اندازی اولیه را انجام دهد.");
          setResetKey((value) => value + 1);
          void loadBusiness();
        }}
      />
      <RemovePanel business={business} />
    </div>
  );
}

function BusinessDetailsPanel({
  business,
  onChanged,
}: {
  business: Business;
  onChanged: () => void;
}) {
  const can = useCan();
  const editable = can("business.edit");
  const [name, setName] = useState(business.name);
  const [timezone, setTimezone] = useState(business.timezone);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(business.name);
    setTimezone(business.timezone);
  }, [business.id, business.name, business.timezone]);

  const changed = name.trim() !== business.name || timezone.trim() !== business.timezone;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const { ok, data } = await api<{ error?: string }>(`/api/platform/businesses/${business.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: name.trim(), timezone: timezone.trim() }),
    });
    setBusy(false);
    if (ok) {
      setSaved(true);
      onChanged();
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
          <p className="mb-1 text-sm font-medium text-white/80">شناسهٔ کسب‌وکار</p>
          <p className="break-all rounded-lg border border-white/10 bg-white/2 px-3 py-2 text-sm text-white/50" dir="ltr">
            {business.slug}
          </p>
          <p className="mt-1 text-xs text-white/40">این شناسه برای پایداری ارجاع‌ها تغییر نمی‌کند.</p>
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
 * Both reset and remove are immediate and irreversible with no other safety
 * net (no archive step, no grace window), so both are confirmed by typing
 * this same fixed phrase rather than the business's own (often Persian, so
 * tedious to retype exactly) slug. Must match `DESTRUCTIVE_CONFIRMATION_PHRASE`
 * in src/lib/platform-admin.ts, which the server actually enforces.
 */
const CONFIRMATION_PHRASE = "delete-me";

function ResetPanel({ business, onChanged }: { business: Business; onChanged: () => void }) {
  const can = useCan();
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!can("business.reset")) return null;

  async function reset() {
    if (
      !confirm(
        `همهٔ داده‌های «${business.name}» حذف شود و کسب‌وکار از ابتدا راه‌اندازی شود؟ این عمل برگشت‌ناپذیر است.`,
      )
    ) {
      return;
    }

    setBusy(true);
    setError(null);
    const { ok, data } = await api<{ error?: string }>(`/api/platform/businesses/${business.id}`, {
      method: "POST",
      body: JSON.stringify({ confirmation }),
    });
    setBusy(false);
    if (ok) {
      setConfirmation("");
      onChanged();
    } else {
      setError(errorMessage(data.error));
    }
  }

  return (
    <Card title="ریست کامل داده‌ها">
      <ErrorBox>{error}</ErrorBox>
      <div className="rounded-lg border border-red-500/25 bg-red-500/8 p-3 text-sm text-red-100">
        <p className="font-semibold">همهٔ داده‌های این کسب‌وکار حذف می‌شوند.</p>
        <p className="mt-1 text-red-100/70">
          سفارش‌ها، انبار، حسابداری، تنظیمات، شعبه‌ها، کاربران و دسترسی‌های ویژگی پاک می‌شوند. تنها هویت سراسری مالک و پلن کسب‌وکار باقی می‌ماند تا راه‌اندازی از ابتدا انجام شود.
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

function RemovePanel({ business }: { business: Business }) {
  const can = useCan();
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!can("business.delete")) return null;

  async function remove() {
    if (
      !confirm(`«${business.name}» برای همیشه حذف شود؟ این عمل قطعی و بازگشت‌ناپذیر است.`)
    ) {
      return;
    }

    setBusy(true);
    setError(null);
    const { ok, data } = await api<{ error?: string }>(`/api/platform/businesses/${business.id}`, {
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
      <div className="rounded-lg border border-red-500/25 bg-red-500/8 p-3 text-sm text-red-100">
        <p className="font-semibold">این کسب‌وکار برای همیشه حذف می‌شود.</p>
        <p className="mt-1 text-red-100/70">
          فوری و قطعی است — بدون بایگانی و بدون مهلت. همهٔ داده‌ها، کاربران، شعبه‌ها و اطلاعات کسب‌وکار از بین می‌روند.
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

function Meta({ label, value, ltr }: { label: string; value: string; ltr?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-white/40">{label}</dt>
      <dd className="mt-0.5 text-white/80" dir={ltr ? "ltr" : undefined}>
        {value}
      </dd>
    </div>
  );
}

/** Persian-digit limit, or "نامحدود" (unlimited) for a null ceiling. */
function limitLabel(n: number | null): string {
  return n === null ? "نامحدود" : formatPersianNumber(n);
}

function PlanPanel({ business, onChanged }: { business: Business; onChanged: () => void }) {
  const can = useCan();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plan, setPlan] = useState(business.plan);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const editable = can("features.write");

  useEffect(() => {
    (async () => {
      const { ok, data } = await api<{ plans: Plan[] }>("/api/platform/plans");
      if (ok) setPlans(data.plans);
    })();
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const { ok, data } = await api<{ error?: string }>(`/api/platform/businesses/${business.id}`, {
      method: "PATCH",
      body: JSON.stringify({ plan }),
    });
    setBusy(false);
    if (ok) {
      setSaved(true);
      onChanged();
    } else {
      setError(errorMessage(data.error));
    }
  }

  const current = plans.find((p) => p.key === plan);

  return (
    <Card title="پلن">
      <ErrorBox>{error}</ErrorBox>
      {saved ? <InfoBox>پلن ذخیره شد.</InfoBox> : null}
      <form onSubmit={save} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <Field label="پلن">
            <select
              value={plan}
              onChange={(e) => setPlan(e.target.value)}
              disabled={!editable || plans.length === 0}
              className={inputClass}
            >
              {/* The business's current plan key always appears, even if it somehow isn't in the fetched catalogue yet. */}
              {!plans.some((p) => p.key === business.plan) ? (
                <option value={business.plan}>{business.plan}</option>
              ) : null}
              {plans.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name} (شعبه: {limitLabel(p.branchLimit)}، عضو: {limitLabel(p.memberLimit)}، سفارش ماهانه:{" "}
                  {limitLabel(p.monthlyOrderLimit)})
                </option>
              ))}
            </select>
          </Field>
          {current ? (
            <p className="mt-1 text-xs text-white/40">
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

function UsagePanel({ id }: { id: string }) {
  const [usage, setUsage] = useState<Usage | null>(null);

  useEffect(() => {
    (async () => {
      const { ok, data } = await api<{ usage: Usage }>(`/api/platform/businesses/${id}/usage`);
      if (ok) setUsage(data.usage);
    })();
  }, [id]);

  if (!usage) {
    return (
      <Card title="مصرف و فعالیت">
        <p className="text-sm text-white/50">در حال بارگذاری…</p>
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
          <div key={s.label} className="rounded-lg border border-white/10 bg-white/2 p-3">
            <p className="text-xs text-white/40">{s.label}</p>
            <p className="mt-1 text-lg font-bold">{s.value}</p>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-white/40">
        آخرین فعالیت: {fmtDate(usage.lastActivity)}
      </p>
    </Card>
  );
}

function FeaturesPanel({ id }: { id: string }) {
  const can = useCan();
  const editable = can("features.write");
  const [features, setFeatures] = useState<Feature[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { ok, data } = await api<{ features: Feature[]; error?: string }>(
      `/api/platform/businesses/${id}/features`,
    );
    if (ok) setFeatures(data.features);
    else setError(errorMessage(data.error));
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function setOverride(flagKey: string, enabled: boolean | null) {
    setPending(flagKey);
    setError(null);
    const { ok, data } = await api<{ features: Feature[]; error?: string }>(
      `/api/platform/businesses/${id}/features`,
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
        <p className="text-sm text-white/50">در حال بارگذاری…</p>
      ) : features.length === 0 ? (
        <p className="text-sm text-white/50">پرچمی تعریف نشده است.</p>
      ) : (
        <div className="space-y-2">
          {features.map((f) => (
            <div
              key={f.key}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/2 p-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">{f.name}</p>
                {f.description ? (
                  <p className="mt-0.5 text-xs text-white/40">{f.description}</p>
                ) : null}
                <p className="mt-1 text-xs text-white/30" dir="ltr">
                  {f.key}
                </p>
              </div>
              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
                <span
                  className={
                    f.effective
                      ? "rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300"
                      : "rounded-full border border-white/20 bg-white/10 px-2 py-0.5 text-xs text-white/50"
                  }
                >
                  {f.effective ? "فعال" : "غیرفعال"}
                </span>
                <span className="text-xs text-white/30">
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
                      className="rounded-md border border-white/15 px-2 py-1 text-xs text-white/70 hover:bg-white/5 disabled:opacity-50"
                    >
                      روشن
                    </button>
                    <button
                      type="button"
                      disabled={pending === f.key}
                      onClick={() => setOverride(f.key, false)}
                      className="rounded-md border border-white/15 px-2 py-1 text-xs text-white/70 hover:bg-white/5 disabled:opacity-50"
                    >
                      خاموش
                    </button>
                    <button
                      type="button"
                      disabled={pending === f.key || f.override === null}
                      onClick={() => setOverride(f.key, null)}
                      className="rounded-md border border-white/15 px-2 py-1 text-xs text-white/70 hover:bg-white/5 disabled:opacity-50"
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

function ImpersonationPanel({ id, businessName }: { id: string; businessName: string }) {
  const can = useCan();
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { ok, data } = await api<{ grants: Grant[]; error?: string }>(
      `/api/platform/impersonation?businessId=${id}`,
    );
    if (ok) setGrants(data.grants);
    else setError(errorMessage(data.error));
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function enter(mode: "read_only" | "full") {
    const label = mode === "full" ? "دسترسی کامل" : "فقط‌خواندنی";
    if (!confirm(`ورود به «${businessName}» با ${label}؟ این اقدام ثبت می‌شود.`)) return;
    setBusy(true);
    setError(null);
    const { ok, data } = await api<{ error?: string }>(
      `/api/platform/businesses/${id}/impersonate`,
      { method: "POST", body: JSON.stringify({ mode, reason: reason.trim() || undefined }) },
    );
    setBusy(false);
    if (ok) {
      // Enter the tenant app; the impersonation cookie is now set.
      window.location.href = "/dashboard";
    } else {
      setError(errorMessage(data.error));
    }
  }

  async function revoke(grantId: string) {
    if (!confirm("این نشست پشتیبانی لغو شود؟")) return;
    const { ok, data } = await api<{ error?: string }>(
      `/api/platform/impersonation/${grantId}?action=revoke`,
      { method: "DELETE" },
    );
    if (ok) void load();
    else setError(errorMessage(data.error));
  }

  function grantState(g: Grant): { label: string; cls: string } {
    if (g.revokedAt) return { label: "لغو‌شده", cls: "text-red-300" };
    if (g.endedAt) return { label: "پایان‌یافته", cls: "text-white/40" };
    if (new Date(g.expiresAt).getTime() <= Date.now())
      return { label: "منقضی", cls: "text-white/40" };
    return { label: "باز", cls: "text-emerald-300" };
  }

  const canReadOnly = can("impersonate.readOnly");
  const canFull = can("impersonate.full");
  const canRevoke = can("impersonate.revoke");

  return (
    <Card title="دسترسی پشتیبانی">
      <ErrorBox>{error}</ErrorBox>

      {canReadOnly || canFull ? (
        <div className="mb-4 rounded-lg border border-white/10 bg-white/2 p-3">
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
              <Button variant="ghost" onClick={() => enter("read_only")} disabled={busy}>
                ورود فقط‌خواندنی
              </Button>
            ) : null}
            {canFull ? (
              <Button variant="danger" onClick={() => enter("full")} disabled={busy}>
                ورود با دسترسی کامل
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {grants === null ? (
        <p className="text-sm text-white/50">در حال بارگذاری…</p>
      ) : grants.length === 0 ? (
        <p className="text-sm text-white/50">هنوز دسترسی پشتیبانی ثبت نشده است.</p>
      ) : (
        <div className="space-y-2">
          {grants.map((g) => {
            const st = grantState(g);
            const open = st.label === "باز";
            return (
              <div
                key={g.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/2 p-3 text-sm"
              >
                <div>
                  <span className="font-medium">
                    {g.mode === "full" ? "دسترسی کامل" : "فقط‌خواندنی"}
                  </span>
                  <span className={`ms-2 text-xs ${st.cls}`}>{st.label}</span>
                  {g.reason ? (
                    <p className="mt-0.5 text-xs text-white/40">{g.reason}</p>
                  ) : null}
                  <p className="mt-0.5 text-xs text-white/30">
                    {fmtDate(g.createdAt)} ← {fmtDate(g.expiresAt)}
                  </p>
                </div>
                {open && canRevoke ? (
                  <button
                    type="button"
                    onClick={() => revoke(g.id)}
                    className="rounded-md border border-red-500/30 px-2 py-1 text-xs text-red-300 hover:bg-red-500/10"
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
