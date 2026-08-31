"use client";

/**
 * Phase 15 — the console landing list: every business on the deployment.
 *
 * Reads `/api/platform/businesses` (any admin), and — for operators holding
 * `business.provision` — opens the provision form inline. Provisioning here
 * seeds the chart of accounts, so the owner it creates can log straight in and
 * sell (exit criterion 1).
 *
 * The list is a real operations surface now: a search box, plan / status /
 * industry filters, a creation-date range, and sorting — all mirrored into
 * the query string so a filtered view survives refresh and can be pasted into
 * a support thread. Filtering happens client-side over the list the console
 * already fetches; a deployment's tenant count is small enough that this is
 * both simpler and snappier than a round-trip per keystroke.
 */
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toPersianDigits, formatPersianNumber } from "@/lib/digits";
import { INDUSTRY_LABELS, type Industry } from "@/lib/industries";
import { validateSubdomain } from "@/lib/slug";
import { IndustryPicker } from "./industry-picker";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import {
  api,
  errorMessage,
  ErrorBox,
  InfoBox,
  Field,
  Button,
  Card,
  StatusBadge,
  EmptyState,
  SkeletonRows,
  PlanBadge,
  StatCard,
  inputClass,
  selectClass,
  fmtDate,
  useCan,
  PLAN_LABELS,
} from "./ui";

interface Business {
  id: string;
  name: string;
  slug: string;
  subdomain: string;
  status: string;
  plan: string;
  industry: Industry;
  locationCount: number;
  memberCount: number;
  orderCount: number;
  lastActivityAt: string | null;
  createdAt: string;
}

/**
 * Phase 23 — a business still on the `biz-xxxxxxxx` host that migration 0066
 * backfilled from its slug. It works, but it is not a name anyone would print
 * on a receipt, so the console flags it for the admin to rename.
 */
function isPlaceholderSubdomain(subdomain: string): boolean {
  return /^biz-[0-9a-f]{8}$/i.test(subdomain);
}

function PlaceholderSubdomainBadge() {
  return (
    <span className="rounded px-1.5 py-0.5 text-[10px] font-medium text-amber-300 ring-1 ring-amber-400/40">
      زیردامنه موقت
    </span>
  );
}

type SortKey = "newest" | "oldest" | "name" | "orders" | "members" | "activity";

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "newest", label: "جدیدترین" },
  { value: "oldest", label: "قدیمی‌ترین" },
  { value: "name", label: "نام (الفبا)" },
  { value: "orders", label: "بیشترین سفارش" },
  { value: "members", label: "بیشترین اعضا" },
  { value: "activity", label: "آخرین فعالیت" },
];

/** Date-range presets, in days back from now; `0` disables the range. */
const DATE_PRESETS = [
  { days: 0, label: "همه" },
  { days: 1, label: "امروز" },
  { days: 7, label: "۷ روز اخیر" },
  { days: 30, label: "۳۰ روز اخیر" },
  { days: 90, label: "۹۰ روز اخیر" },
  { days: 365, label: "یک سال اخیر" },
];

interface Filters {
  q: string;
  plan: string; // "" = all
  status: string; // "" = all
  industry: string; // "" = all
  from: string; // yyyy-mm-dd (inclusive, local)
  to: string; // yyyy-mm-dd (inclusive, local)
  sort: SortKey;
}

const EMPTY_FILTERS: Filters = {
  q: "",
  plan: "",
  status: "",
  industry: "",
  from: "",
  to: "",
  sort: "newest",
};

function filtersFromParams(params: URLSearchParams): Filters {
  const sort = params.get("sort");
  return {
    q: params.get("q") ?? "",
    plan: params.get("plan") ?? "",
    status: params.get("status") ?? "",
    industry: params.get("industry") ?? "",
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
    sort: SORT_OPTIONS.some((o) => o.value === sort) ? (sort as SortKey) : "newest",
  };
}

function isFiltered(f: Filters): boolean {
  return Boolean(f.q || f.plan || f.status || f.industry || f.from || f.to);
}

function BusinessesListInner() {
  const can = useCan();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [businesses, setBusinesses] = useState<Business[] | null>(null);
  const [rootDomain, setRootDomain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [filters, setFilters] = useState<Filters>(() => filtersFromParams(params));
  const [preset, setPreset] = useState(0);

  // Filters live in state so typing stays instant; the URL mirrors them on
  // every change (shareable, refresh-safe) and the state re-hydrates when the
  // operator uses the browser back/forward buttons. `params` is read only for
  // the initial value + popstate — a per-keystroke round-trip would lag.
  useEffect(() => {
    const onPop = () => {
      setFilters(filtersFromParams(new URLSearchParams(window.location.search)));
      setPreset(0);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const patch = useCallback(
    (next: Partial<Filters>) => {
      const merged = { ...filters, ...next };
      const qs = new URLSearchParams();
      for (const key of ["q", "plan", "status", "industry", "from", "to"] as const) {
        if (merged[key]) qs.set(key, merged[key]);
      }
      if (merged.sort !== EMPTY_FILTERS.sort) qs.set("sort", merged.sort);
      const query = qs.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [filters, pathname, router],
  );

  const load = useCallback(async () => {
    const { ok, data } = await api<{ businesses: Business[]; rootDomain?: string; error?: string }>(
      "/api/platform/businesses",
    );
    if (ok) {
      setBusinesses(data.businesses);
      setRootDomain(data.rootDomain ?? "");
    } else setError(errorMessage(data.error));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const allPlans = useMemo(() => {
    const keys = new Set((businesses ?? []).map((b) => b.plan));
    return Array.from(keys).sort();
  }, [businesses]);

  const allIndustries = useMemo(() => {
    const keys = new Set((businesses ?? []).map((b) => String(b.industry)));
    return Array.from(keys).sort();
  }, [businesses]);

  const visible = useMemo(() => {
    const list = businesses ?? [];
    const q = filters.q.trim().toLowerCase();
    const fromTs = filters.from ? new Date(`${filters.from}T00:00:00`).getTime() : null;
    const toTs = filters.to ? new Date(`${filters.to}T23:59:59.999`).getTime() : null;
    const presetTs =
      !fromTs && !toTs && preset > 0 ? Date.now() - preset * 24 * 60 * 60 * 1000 : null;

    const filtered = list.filter((b) => {
      if (q && !`${b.name} ${b.slug} ${b.subdomain}`.toLowerCase().includes(q)) return false;
      if (filters.plan && b.plan !== filters.plan) return false;
      if (filters.status && b.status !== filters.status) return false;
      if (filters.industry && String(b.industry) !== filters.industry) return false;
      const created = new Date(b.createdAt).getTime();
      if (fromTs !== null && created < fromTs) return false;
      if (toTs !== null && created > toTs) return false;
      if (presetTs !== null && created < presetTs) return false;
      return true;
    });

    const by: Record<SortKey, (a: Business, b: Business) => number> = {
      newest: (a, b) => +new Date(b.createdAt) - +new Date(a.createdAt),
      oldest: (a, b) => +new Date(a.createdAt) - +new Date(b.createdAt),
      name: (a, b) => a.name.localeCompare(b.name, "fa"),
      orders: (a, b) => b.orderCount - a.orderCount,
      members: (a, b) => b.memberCount - a.memberCount,
      activity: (a, b) =>
        +new Date(b.lastActivityAt ?? 0) - +new Date(a.lastActivityAt ?? 0),
    };
    return filtered.sort(by[filters.sort]);
  }, [businesses, filters, preset]);

  const stats = useMemo(() => {
    const list = businesses ?? [];
    return {
      total: list.length,
      active: list.filter((b) => b.status === "active").length,
      suspended: list.filter((b) => b.status === "suspended").length,
      archived: list.filter((b) => b.status === "archived").length,
      tempSub: list.filter((b) => isPlaceholderSubdomain(b.subdomain)).length,
      noActivity: list.filter((b) => !b.lastActivityAt).length,
    };
  }, [businesses]);

  const hasFilters = isFiltered(filters);

  return (
    <div className="mx-auto w-full max-w-6xl">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">کسب‌وکارها</h1>
          <p className="mt-1 text-sm text-white/40">
            {businesses
              ? hasFilters
                ? `${toPersianDigits(visible.length)} از ${toPersianDigits(businesses.length)} کسب‌وکار`
                : `${toPersianDigits(businesses.length)} کسب‌وکار`
              : "…"}
          </p>
        </div>
        {can("business.provision") ? (
          <Button onClick={() => setShowForm((v) => !v)} className="w-full sm:w-auto">
            {showForm ? "بستن" : "ایجاد کسب‌وکار"}
          </Button>
        ) : null}
      </div>

      {businesses ? (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
          <StatCard label="کل کسب‌وکارها" value={formatPersianNumber(stats.total)} />
          <StatCard label="فعال" value={formatPersianNumber(stats.active)} tone="ok" />
          <StatCard label="معلق" value={formatPersianNumber(stats.suspended)} tone={stats.suspended ? "warn" : "neutral"} />
          <StatCard label="بایگانی" value={formatPersianNumber(stats.archived)} />
          <StatCard
            label="زیردامنه موقت"
            value={formatPersianNumber(stats.tempSub)}
            tone={stats.tempSub ? "warn" : "neutral"}
            hint={stats.tempSub ? "منتظر انتخاب نشانی انگلیسی" : undefined}
          />
          <StatCard
            label="بدون سفارش"
            value={formatPersianNumber(stats.noActivity)}
            hint="هر سفارشی ثبت نکرده‌اند"
          />
        </div>
      ) : null}

      <ErrorBox>{error}</ErrorBox>

      {showForm && can("business.provision") ? (
        <div className="mb-6">
          <ProvisionForm
            rootDomain={rootDomain}
            onDone={() => {
              setShowForm(false);
              void load();
            }}
          />
        </div>
      ) : null}

      {businesses === null ? (
        <SkeletonRows rows={5} />
      ) : (
        <>
          <FilterBar
            filters={filters}
            onPatch={patch}
            preset={preset}
            onPreset={(d) => {
              setPreset(d);
              patch({ from: "", to: "" });
            }}
            onDateEdit={() => setPreset(0)}
            onClear={() => {
              setPreset(0);
              setFilters(EMPTY_FILTERS);
              router.replace(pathname, { scroll: false });
            }}
            plans={allPlans}
            industries={allIndustries}
            resultCount={visible.length}
            totalCount={businesses.length}
          />

          {businesses.length === 0 ? (
            <Card>
              <p className="text-sm text-white/50">هنوز کسب‌وکاری ثبت نشده است.</p>
            </Card>
          ) : visible.length === 0 ? (
            <EmptyState
              title="هیچ کسب‌وکاری با این فیلترها پیدا نشد."
              hint="عبارت جستجو یا یکی از فیلترها را بردارید."
              action={
                <Button
                  variant="ghost"
                  onClick={() => {
                    setPreset(0);
                    setFilters(EMPTY_FILTERS);
                    router.replace(pathname, { scroll: false });
                  }}
                >
                  حذف فیلترها
                </Button>
              }
            />
          ) : (
            <>
              <div className="space-y-3 md:hidden">
                {visible.map((b) => (
                  <BusinessListCard key={b.id} business={b} />
                ))}
              </div>
              <div className="hidden overflow-x-auto rounded-xl border border-white/10 md:block">
                <table className="min-w-[760px] w-full text-sm">
                  <thead className="bg-white/3 text-white/50">
                    <tr>
                      <th className="px-4 py-3 text-start font-medium">نام</th>
                      <th className="px-4 py-3 text-start font-medium">نوع</th>
                      <th className="px-4 py-3 text-start font-medium">وضعیت</th>
                      <th className="px-4 py-3 text-start font-medium">پلن</th>
                      <th className="px-4 py-3 text-start font-medium">شعبه</th>
                      <th className="px-4 py-3 text-start font-medium">اعضا</th>
                      <th className="px-4 py-3 text-start font-medium">سفارش</th>
                      <th className="px-4 py-3 text-start font-medium">ایجاد</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((b) => (
                      <tr
                        key={b.id}
                        className="border-t border-white/5 transition-colors hover:bg-white/3"
                      >
                        <td className="px-4 py-3">
                          <Link
                            href={"/platform/businesses/" + b.id}
                            className="font-medium text-sky-300 hover:underline"
                          >
                            {b.name}
                          </Link>
                          <span className="mt-0.5 flex items-center gap-2 text-xs text-white/30">
                            <span dir="ltr">{b.subdomain}</span>
                            {isPlaceholderSubdomain(b.subdomain) ? <PlaceholderSubdomainBadge /> : null}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-white/70">{INDUSTRY_LABELS[b.industry]}</td>
                        <td className="px-4 py-3">
                          <StatusBadge status={b.status} />
                        </td>
                        <td className="px-4 py-3">
                          <PlanBadge plan={b.plan} />
                        </td>
                        <td className="px-4 py-3 text-white/70 tabular-nums">
                          {formatPersianNumber(b.locationCount)}
                        </td>
                        <td className="px-4 py-3 text-white/70 tabular-nums">
                          {formatPersianNumber(b.memberCount)}
                        </td>
                        <td className="px-4 py-3 text-white/70 tabular-nums">
                          {formatPersianNumber(b.orderCount)}
                        </td>
                        <td className="px-4 py-3 text-white/50 whitespace-nowrap">
                          {fmtDate(b.createdAt, true)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

export default function BusinessesPage() {
  // useSearchParams needs a Suspense boundary at prerender; the shell keeps
  // the fallback cheap because the real list only ever depends on data anyway.
  return (
    <Suspense fallback={<SkeletonRows rows={8} label="در حال بارگذاری فهرست کسب‌وکارها" />}>
      <BusinessesListInner />
    </Suspense>
  );
}

function FilterBar({
  filters,
  onPatch,
  preset,
  onPreset,
  onDateEdit,
  onClear,
  plans,
  industries,
  resultCount,
  totalCount,
}: {
  filters: Filters;
  onPatch: (next: Partial<Filters>) => void;
  preset: number;
  onPreset: (days: number) => void;
  onDateEdit: () => void;
  onClear: () => void;
  plans: string[];
  industries: string[];
  resultCount: number;
  totalCount: number;
}) {
  const hasFilters = isFiltered(filters);
  return (
    <Card>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]">
        <Field label="جستجو">
          <input
            value={filters.q}
            onChange={(e) => onPatch({ q: e.target.value })}
            className={inputClass}
            placeholder="نام، شناسه یا زیردامنه…"
          />
        </Field>
        <Field label="پلن">
          <select
            value={filters.plan}
            onChange={(e) => onPatch({ plan: e.target.value })}
            className={selectClass}
          >
            <option value="">همه پلن‌ها</option>
            {plans.map((p) => (
              <option key={p} value={p}>
                {planOptionLabel(p)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="وضعیت">
          <select
            value={filters.status}
            onChange={(e) => onPatch({ status: e.target.value })}
            className={selectClass}
          >
            <option value="">همه وضعیت‌ها</option>
            <option value="active">فعال</option>
            <option value="suspended">معلق</option>
            <option value="archived">بایگانی</option>
          </select>
        </Field>
        <Field label="نوع کسب‌وکار">
          <select
            value={filters.industry}
            onChange={(e) => onPatch({ industry: e.target.value })}
            className={selectClass}
          >
            <option value="">همه انواع</option>
            {industries.map((i) => (
              <option key={i} value={i}>
                {INDUSTRY_LABELS[i as Industry] ?? i}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="mt-1 flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <p className="mb-1 text-sm font-medium text-white/80">تاریخ ایجاد</p>
          <div className="flex flex-wrap items-center gap-1.5">
            {DATE_PRESETS.map((p) => (
              <button
                key={p.days}
                type="button"
                onClick={() => onPreset(p.days)}
                className={
                  preset === p.days && !filters.from && !filters.to
                    ? "rounded-full border border-sky-400/50 bg-sky-500/15 px-3 py-1 text-xs font-medium text-sky-300"
                    : "rounded-full border border-white/15 px-3 py-1 text-xs text-white/55 transition-colors hover:bg-white/5 hover:text-white"
                }
              >
                {p.label}
              </button>
            ))}
            <span className="mx-1 h-5 w-px bg-white/10" aria-hidden />
            <label className="flex items-center gap-1 text-xs text-white/45">
              از
              <JalaliDatePicker
                className={`${inputClass} !h-8 w-[9.5rem] text-xs`}
                popoverClass="dark absolute z-50 mt-1 w-64 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg"
                value={filters.from}
                onChange={(v) => {
                  onDateEdit();
                  onPatch({ from: v });
                }}
              />
            </label>
            <label className="flex items-center gap-1 text-xs text-white/45">
              تا
              <JalaliDatePicker
                className={`${inputClass} !h-8 w-[9.5rem] text-xs`}
                popoverClass="dark absolute z-50 mt-1 w-64 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg"
                value={filters.to}
                onChange={(v) => {
                  onDateEdit();
                  onPatch({ to: v });
                }}
              />
            </label>
          </div>
        </div>

        <div className="flex items-end gap-2">
          <label className="flex items-center gap-2 text-xs text-white/45">
            مرتب‌سازی
            <select
              value={filters.sort}
              onChange={(e) => onPatch({ sort: e.target.value as SortKey })}
              className={`${selectClass} !h-8 w-auto text-xs`}
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          {hasFilters ? (
            <Button variant="ghost" onClick={onClear} className="!h-8 text-xs">
              حذف فیلترها
            </Button>
          ) : (
            <span className="whitespace-nowrap pb-1 text-[11px] text-white/30">
              {toPersianDigits(resultCount)} از {toPersianDigits(totalCount)}
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}

function planOptionLabel(key: string): string {
  return PLAN_LABELS[key] ?? key;
}

function BusinessListCard({ business }: { business: Business }) {
  return (
    <Link
      href={"/platform/businesses/" + business.id}
      className="block rounded-xl border border-white/10 bg-white/3 p-4 transition-colors hover:bg-white/5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-semibold text-sky-300">{business.name}</p>
          <p className="mt-1 break-all text-xs text-white/35" dir="ltr">
            {business.subdomain}
          </p>
          {isPlaceholderSubdomain(business.subdomain) ? (
            <p className="mt-1">
              <PlaceholderSubdomainBadge />
            </p>
          ) : null}
        </div>
        <StatusBadge status={business.status} />
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs text-white/40">نوع</dt>
          <dd className="mt-1 text-white/80">{INDUSTRY_LABELS[business.industry]}</dd>
        </div>
        <div>
          <dt className="text-xs text-white/40">پلن</dt>
          <dd className="mt-1 text-white/80">
            <PlanBadge plan={business.plan} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-white/40">شعبه / اعضا</dt>
          <dd className="mt-1 text-white/80 tabular-nums">
            {formatPersianNumber(business.locationCount)} / {formatPersianNumber(business.memberCount)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-white/40">سفارش‌ها</dt>
          <dd className="mt-1 text-white/80 tabular-nums">{formatPersianNumber(business.orderCount)}</dd>
        </div>
        <div>
          <dt className="text-xs text-white/40">آخرین فعالیت</dt>
          <dd className="mt-1 text-white/60">{fmtDate(business.lastActivityAt, true)}</dd>
        </div>
        <div>
          <dt className="text-xs text-white/40">ایجاد</dt>
          <dd className="mt-1 text-white/60">{fmtDate(business.createdAt, true)}</dd>
        </div>
      </dl>
    </Link>
  );
}

function ProvisionForm({ onDone, rootDomain }: { onDone: () => void; rootDomain: string }) {
  const [businessName, setBusinessName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Phase 24 — where the Owner's SMS second factor is sent. Deliberately the
  // Owner's own mobile and not the branch's landline, which is a separate
  // field on the location: one-time passwords must not go to the counter phone.
  const [ownerPhone, setOwnerPhone] = useState("");
  const [locationName, setLocationName] = useState("");
  // The business's public address, typed in English by the admin. Deliberately
  // NOT prefilled from the business name: names here are Persian, and a
  // transliteration of one ("kafeh-shahr-e-ma") is a poor thing to print on a
  // receipt or read down a phone. The admin chooses it, and it is required.
  const [subdomain, setSubdomain] = useState("");
  // Which industry the tenant is: it selects the chart of accounts seeded
  // below, the setup-wizard path its owner walks, and (Phase 25 Wave 2) which
  // modules and labels the dashboard shows. Until this form asked, every
  // console-provisioned business silently became a café.
  const [industry, setIndustry] = useState<Industry>("food_service");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Phase 24 Wave 2 — the one and only showing of the new Owner's recovery
   * codes (and, on a local install, their TOTP secret).
   *
   * Held in state rather than auto-dismissed with the rest of the form,
   * because these values cannot be recovered: the operator has to copy them
   * out and hand them over before this panel is closed.
   */
  const [handover, setHandover] = useState<ProvisionMfaHandover | null>(null);

  // Only complain about what has actually been typed; "empty" is enforced by
  // the field being required, not by an error message under a pristine form.
  const subdomainError = subdomain ? validateSubdomain(subdomain) : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    const { ok, data } = await api<{ error?: string; mfa?: ProvisionMfaHandover }>(
      "/api/platform/businesses",
      {
        method: "POST",
        body: JSON.stringify({
          businessName: businessName.trim(),
          ownerName: ownerName.trim(),
          email: email.trim().toLowerCase(),
          password,
          ownerPhone: ownerPhone.trim(),
          locationName: locationName.trim() || undefined,
          subdomain,
          industry,
        }),
      },
    );
    setBusy(false);
    if (ok) {
      setInfo("کسب‌وکار ایجاد شد. مالک اکنون می‌تواند وارد شود.");
      // The recovery codes stop the clock: the panel stays until the operator
      // confirms they have passed them on, rather than the form closing itself
      // after 800ms and taking the only copy with it.
      if (data.mfa && (data.mfa.recoveryCodes?.length || data.mfa.totpSecret)) {
        setHandover(data.mfa);
        return;
      }
      setTimeout(onDone, 800);
    } else {
      setError(errorMessage(data.error));
    }
  }

  if (handover) {
    return <ProvisionMfaPanel handover={handover} ownerEmail={email.trim().toLowerCase()} onDone={onDone} />;
  }

  return (
    <Card title="ایجاد کسب‌وکار جدید">
      <form onSubmit={submit}>
        <ErrorBox>{error}</ErrorBox>
        <InfoBox>{info}</InfoBox>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="نام کسب‌وکار">
            <input
              required
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field
            label="نشانی اینترنتی (زیردامنه)"
            hint={
              subdomainError
                ? undefined
                : subdomain && rootDomain
                  ? `کسب‌وکار از این نشانی سرو می‌شود: https://${subdomain}.${rootDomain}`
                  : rootDomain
                    ? `نام انگلیسی کسب‌وکار را وارد کنید؛ نشانی آن زیر ${rootDomain} ساخته می‌شود.`
                    : "نام انگلیسی کسب‌وکار: فقط حروف انگلیسی کوچک، رقم و خط تیره."
            }
          >
            <input
              required
              dir="ltr"
              value={subdomain}
              onChange={(e) => setSubdomain(e.target.value.trim().toLowerCase())}
              className={`${inputClass} text-start`}
              placeholder="acme"
            />
            {subdomainError ? (
              <span className="mt-1 block text-xs text-rose-300">{errorMessage(subdomainError)}</span>
            ) : null}
          </Field>
          <div className="sm:col-span-2">
            <Field
              label="نوع کسب‌وکار"
              hint="سرفصل حساب‌ها، مراحل راه‌اندازی و ماژول‌های کسب‌وکار بر اساس همین انتخاب ساخته می‌شوند."
            >
              <IndustryPicker value={industry} onChange={setIndustry} disabled={busy} />
            </Field>
          </div>
          <Field label="نام شعبه" hint="خالی بماند، «شعبه مرکزی» ساخته می‌شود.">
            <input
              value={locationName}
              onChange={(e) => setLocationName(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="نام مالک">
            <input
              required
              value={ownerName}
              onChange={(e) => setOwnerName(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="ایمیل مالک">
            <input
              type="email"
              dir="ltr"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={`${inputClass} text-start`}
            />
          </Field>
          <Field label="رمز عبور مالک" hint="حداقل ۸ نویسه.">
            <input
              type="password"
              dir="ltr"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
            />
          </Field>
          {/* Phase 24 — the Owner's own mobile, not the branch line: their
              second factor is texted here as the business is created. */}
          <Field label="موبایل مالک" hint="کد ورود دومرحله‌ای به این شماره پیامک می‌شود.">
            <input
              type="tel"
              dir="ltr"
              required
              placeholder="09121234567"
              value={ownerPhone}
              onChange={(e) => setOwnerPhone(e.target.value)}
              className={`${inputClass} text-start`}
            />
          </Field>
        </div>
        <div className="mt-2">
          <Button type="submit" disabled={busy || Boolean(subdomainError)}>
            {busy ? "در حال ایجاد…" : "ایجاد و راه‌اندازی"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** The one-time second-factor material `/api/platform/businesses` returns on create. */
interface ProvisionMfaHandover {
  method: "totp" | "sms_otp";
  totpSecret: string | null;
  totpUrl: string | null;
  totpQr: string | null;
  recoveryCodes: string[];
}

/**
 * Phase 24 Wave 2 — hand the new Owner's second-factor material over, once.
 *
 * Provisioning enrols the Owner's second factor in the same transaction that
 * creates the business (so a business has working 2FA from the moment it
 * exists, rather than depending on someone remembering later), and mints ten
 * recovery codes. Nothing can show them again: the TOTP secret is stored
 * encrypted and the codes only as bcrypt hashes.
 *
 * The operator is therefore holding, for the length of this panel, credentials
 * that belong to someone else — so the copy says plainly that they are to be
 * handed over and not kept, and the panel will not close on a timer.
 */
function ProvisionMfaPanel({
  handover,
  ownerEmail,
  onDone,
}: {
  handover: ProvisionMfaHandover;
  ownerEmail: string;
  onDone: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);

  return (
    <Card title="ورود دومرحله‌ای مالک — فقط یک بار نمایش داده می‌شود">
      <InfoBox>
        کسب‌وکار ساخته شد. موارد زیر را به مالک ({ownerEmail}) تحویل دهید و نزد خود نگه ندارید؛ پس
        از بستن این پنجره دیگر قابل نمایش نیستند.
      </InfoBox>

      {handover.method === "sms_otp" ? (
        <p className="mb-4 text-sm text-white/60">
          روش اصلی ورود دومرحله‌ای این مالک، پیامک یک‌بارمصرف به شمارهٔ موبایلی است که وارد کردید.
        </p>
      ) : null}

      {handover.totpQr ? (
        <div className="mb-4 flex justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={handover.totpQr}
            alt="کد QR ورود دومرحله‌ای"
            className="size-48 rounded-lg bg-white p-2"
          />
        </div>
      ) : null}

      {handover.totpSecret ? (
        <div className="mb-4">
          <p className="mb-1 text-sm text-white/60">کد دستی برنامهٔ رمزساز:</p>
          <p
            dir="ltr"
            className="rounded-lg border border-white/15 bg-white/5 px-3 py-2 font-mono text-sm tracking-wider text-white"
          >
            {handover.totpSecret}
          </p>
        </div>
      ) : null}

      {handover.recoveryCodes.length > 0 ? (
        <div className="mb-4">
          <p className="mb-2 text-sm text-white/60">
            ۱۰ کد بازیابی یک‌بارمصرف — تنها راه ورود مالک در صورت گم‌شدن گوشی:
          </p>
          <div
            dir="ltr"
            className="grid grid-cols-2 gap-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 font-mono text-sm tracking-wider text-white"
          >
            {handover.recoveryCodes.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
          <div className="mt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(handover.recoveryCodes.join("\n"));
                  setCopied(true);
                } catch {
                  setCopied(false);
                }
              }}
            >
              {copied ? "کپی شد" : "کپی کدها"}
            </Button>
          </div>
        </div>
      ) : null}

      <label className="mb-4 flex items-start gap-2 text-sm text-white/80">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-1 size-4"
        />
        <span>این اطلاعات را به مالک تحویل دادم.</span>
      </label>

      <Button type="button" disabled={!confirmed} onClick={onDone}>
        بستن
      </Button>
    </Card>
  );
}
