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
  deleteEligible: boolean;
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

  async function hardDelete() {
    if (!confirm(`حذف قطعی «${business?.name}»؟ این عمل بازگشت‌ناپذیر است.`)) return;
    setError(null);
    const { ok, data } = await api<{ error?: string }>(`/api/platform/businesses/${id}`, {
      method: "DELETE",
    });
    if (ok) {
      window.location.href = "/platform";
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
    <div className="mx-auto max-w-4xl space-y-6">
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
          {business.status === "archived" && can("business.delete") ? (
            <Button variant="danger" onClick={hardDelete} disabled={!business.deleteEligible}>
              حذف قطعی
            </Button>
          ) : null}
        </div>
        {business.status === "archived" && !business.deleteEligible ? (
          <p className="mt-2 text-xs text-white/40">
            این کسب‌وکار هنوز در بازهٔ مهلت حذف است و قابل حذف قطعی نیست.
          </p>
        ) : null}
      </Card>

      <PlanPanel business={business} onChanged={loadBusiness} />
      <UsagePanel id={id} />
      <FeaturesPanel id={id} />
      <ImpersonationPanel id={id} businessName={business.name} />
    </div>
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

function PlanPanel({ business, onChanged }: { business: Business; onChanged: () => void }) {
  const can = useCan();
  const [plan, setPlan] = useState(business.plan);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const editable = can("features.write");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const { ok, data } = await api<{ error?: string }>(`/api/platform/businesses/${business.id}`, {
      method: "PATCH",
      body: JSON.stringify({ plan: plan.trim() }),
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
    <Card title="پلن">
      <ErrorBox>{error}</ErrorBox>
      {saved ? <InfoBox>پلن ذخیره شد.</InfoBox> : null}
      <form onSubmit={save} className="flex items-end gap-3">
        <div className="flex-1">
          <Field label="نام پلن">
            <input
              value={plan}
              onChange={(e) => setPlan(e.target.value)}
              disabled={!editable}
              className={inputClass}
            />
          </Field>
        </div>
        {editable ? (
          <div className="mb-4">
            <Button type="submit" disabled={busy || plan.trim() === business.plan}>
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
          <div key={s.label} className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
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
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] p-3"
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
              <div className="flex items-center gap-2">
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
                  <div className="flex gap-1">
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
        <div className="mb-4 rounded-lg border border-white/10 bg-white/[0.02] p-3">
          <Field label="دلیل (اختیاری، در گزارش ثبت می‌شود)">
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className={inputClass}
              placeholder="مثلاً: بررسی مشکل چاپ رسید"
            />
          </Field>
          <div className="flex gap-2">
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
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/[0.02] p-3 text-sm"
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
