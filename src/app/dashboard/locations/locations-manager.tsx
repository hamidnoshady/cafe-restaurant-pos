"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

/**
 * Owner's cross-location view (Phase 9). Three cards:
 *  1. Comparison — sales/COGS/waste/staff for every remote location that has
 *     pushed to this server (this server acting as "central").
 *  2. Registry — register remote locations, show their token exactly once,
 *     watch last-sync/staleness, deactivate (which revokes the token).
 *  3. Local sync — where THIS server pushes its own numbers (acting as a
 *     "location"), with status and a manual "sync now".
 */
import { useCallback, useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { JalaliDatePicker } from "../jalali-date-picker";
import { BarChart } from "../charts";
import { ErrorBox, Field, InfoBox, PrimaryButton, SecondaryButton, api, inputClass } from "../ui";
import { SectionCard } from "../page-chrome";

interface StaffRow {
  staffId: string;
  staffName: string;
  role: string | null;
  orderCount: number;
  revenue: number;
}

interface LocationTotals {
  id: string;
  name: string;
  lastSyncedAt: string | null;
  stale: boolean;
  orderCount: number;
  total: number;
  discount: number;
  cashTotal: number;
  cardTotal: number;
  onlineTotal: number;
  creditTotal: number;
  cogs: number;
  wasteCost: number;
  topStaff: StaffRow[];
}

interface Overview {
  from: string;
  to: string;
  locations: LocationTotals[];
  series: { day: string; locationId: string; total: number }[];
}

interface RegistryRow {
  id: string;
  name: string;
  lastSyncedAt: string | null;
  stale: boolean;
  isActive: boolean;
}

interface SyncConfig {
  centralUrl: string;
  token: string;
  enabled: boolean;
}

interface SyncState {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastSuccessDay: string | null;
  lastError: string | null;
}

function formatSyncTime(iso: string | null): string {
  if (!iso) return "هرگز";
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tehran",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
  return `${toPersianDigits(formatJalali(iso))} ${toPersianDigits(time)}`;
}

function StaleBadge({ stale }: { stale: boolean }) {
  return stale ? (
    <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
      قطع همگام‌سازی
    </span>
  ) : (
    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
      به‌روز
    </span>
  );
}

export function LocationsManager() {
  return (
    <div className="space-y-6">
      <ComparisonCard />
      <RegistryCard />
      <LocalSyncCard />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. Cross-location comparison
// ---------------------------------------------------------------------------

function ComparisonCard() {
  const money = useMoney();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (dateFrom) params.set("from", dateFrom);
    if (dateTo) params.set("to", dateTo);
    const res = await api<{ overview?: Overview; error?: string }>(`/api/rollup/overview?${params}`);
    if (!res.ok) {
      setError("خطا در بارگذاری مقایسهٔ شعبه‌ها.");
      return;
    }
    setError(null);
    setOverview(res.data.overview ?? null);
  }, [dateFrom, dateTo]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <SectionCard
      title="مقایسهٔ شعبه‌ها"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-36">
            <JalaliDatePicker value={dateFrom} onChange={setDateFrom} placeholder="از تاریخ" />
          </div>
          <span className="text-xs text-muted-foreground">تا</span>
          <div className="w-36">
            <JalaliDatePicker value={dateTo} onChange={setDateTo} placeholder="تا تاریخ" />
          </div>
        </div>
      }
    >
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {!overview ? (
        <LoadingSkeleton rows={3} />
      ) : overview.locations.length === 0 ? (
        <InfoBox>
          هنوز شعبه‌ای داده‌ای ارسال نکرده است. ابتدا در بخش «شعبه‌های ثبت‌شده» یک شعبه ثبت کنید و
          توکن آن را در تنظیمات همگام‌سازی همان شعبه وارد کنید.
        </InfoBox>
      ) : (
        <div className="space-y-6">
          <p className="text-xs text-muted-foreground">
            بازهٔ {toPersianDigits(formatJalali(overview.from))} تا {toPersianDigits(formatJalali(overview.to))}
            {" — "}ارقام به تومان.
          </p>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b text-start text-xs text-muted-foreground">
                  <th className="py-2 text-start font-medium">شعبه</th>
                  <th className="py-2 text-start font-medium">فروش</th>
                  <th className="py-2 text-start font-medium">سفارش</th>
                  <th className="py-2 text-start font-medium">بهای تمام‌شده (COGS)</th>
                  <th className="py-2 text-start font-medium">ضایعات</th>
                  <th className="py-2 text-start font-medium">نقدی</th>
                  <th className="py-2 text-start font-medium">کارتی</th>
                  <th className="py-2 text-start font-medium">وضعیت</th>
                </tr>
              </thead>
              <tbody>
                {overview.locations.map((l) => (
                  <tr key={l.id} className="border-b last:border-0">
                    <td className="py-2 font-medium">{l.name}</td>
                    <td className="py-2 tabular-nums">{money.format(l.total, { withUnit: false })}</td>
                    <td className="py-2 tabular-nums">{toPersianDigits(l.orderCount)}</td>
                    <td className="py-2 tabular-nums">{money.format(l.cogs, { withUnit: false })}</td>
                    <td className="py-2 tabular-nums">{money.format(l.wasteCost, { withUnit: false })}</td>
                    <td className="py-2 tabular-nums">{money.format(l.cashTotal, { withUnit: false })}</td>
                    <td className="py-2 tabular-nums">{money.format(l.cardTotal, { withUnit: false })}</td>
                    <td className="py-2">
                      <StaleBadge stale={l.stale} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <h3 className="mb-2 text-sm font-medium text-muted-foreground">فروش دوره به تفکیک شعبه ({money.unitLabel})</h3>
            <BarChart
              data={overview.locations.map((l) => ({ label: l.name, value: Math.trunc(l.total / 10) }))}
            />
          </div>

          <div>
            <h3 className="mb-2 text-sm font-medium text-muted-foreground">برترین کارکنان هر شعبه</h3>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {overview.locations.map((l) => (
                <div key={l.id} className="rounded-xl border p-3">
                  <p className="mb-2 text-sm font-semibold">{l.name}</p>
                  {l.topStaff.length === 0 ? (
                    <p className="text-xs text-muted-foreground">داده‌ای ثبت نشده است.</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {l.topStaff.map((s) => (
                        <li key={s.staffId} className="flex items-center justify-between gap-2 text-xs">
                          <span className="truncate">{s.staffName}</span>
                          <span className="shrink-0 tabular-nums text-muted-foreground">
                            {toPersianDigits(s.orderCount)} سفارش · {money.format(s.revenue, { withUnit: false })}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// 2. Registered remote locations (this server as "central")
// ---------------------------------------------------------------------------

function RegistryCard() {
  const [locations, setLocations] = useState<RegistryRow[] | null>(null);
  const [name, setName] = useState("");
  const [newToken, setNewToken] = useState<{ name: string; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api<{ locations?: RegistryRow[] }>("/api/rollup/locations");
    if (res.ok) setLocations(res.data.locations ?? []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function register(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    const res = await api<{ token?: string; error?: string }>("/api/rollup/locations", {
      method: "POST",
      body: JSON.stringify({ name: name.trim() }),
    });
    setBusy(false);
    if (!res.ok || !res.data.token) {
      setError("ثبت شعبه ناموفق بود.");
      return;
    }
    setNewToken({ name: name.trim(), token: res.data.token });
    setName("");
    load();
  }

  async function setActive(id: string, isActive: boolean) {
    await api(`/api/rollup/locations/${id}`, { method: "PATCH", body: JSON.stringify({ isActive }) });
    load();
  }

  return (
    <SectionCard title="شعبه‌های ثبت‌شده">
      <p className="mb-4 text-sm text-muted-foreground">
        برای هر شعبه یک توکن صادر می‌شود؛ آن را در «همگام‌سازی با سرور مرکزی» همان شعبه وارد کنید.
        توکن فقط همین یک بار نمایش داده می‌شود.
      </p>

      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {newToken ? (
        <div className="mb-4 rounded-xl border border-primary/30 bg-primary/5 p-3">
          <p className="mb-2 text-sm">
            توکن شعبهٔ «{newToken.name}» — همین حالا کپی کنید؛ دیگر نمایش داده نمی‌شود:
          </p>
          <div className="flex items-center gap-2">
            <code dir="ltr" className="flex-1 overflow-x-auto rounded-lg bg-muted px-3 py-2 text-xs">
              {newToken.token}
            </code>
            <SecondaryButton onClick={() => navigator.clipboard?.writeText(newToken.token)}>
              کپی
            </SecondaryButton>
            <SecondaryButton onClick={() => setNewToken(null)}>بستن</SecondaryButton>
          </div>
        </div>
      ) : null}

      {!locations ? (
        <LoadingSkeleton rows={3} />
      ) : locations.length === 0 ? (
        <p className="mb-4 text-sm text-muted-foreground">هنوز شعبه‌ای ثبت نشده است.</p>
      ) : (
        <ul className="mb-4 divide-y">
          {locations.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <div className="flex items-center gap-2">
                <span className={`text-sm font-medium ${l.isActive ? "" : "text-muted-foreground line-through"}`}>
                  {l.name}
                </span>
                {l.isActive ? <StaleBadge stale={l.stale} /> : null}
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground">
                  آخرین همگام‌سازی: {formatSyncTime(l.lastSyncedAt)}
                </span>
                <SecondaryButton onClick={() => setActive(l.id, !l.isActive)}>
                  {l.isActive ? "غیرفعال" : "فعال"}
                </SecondaryButton>
              </div>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={register} className="flex items-end gap-2">
        <div className="flex-1">
          <Field label="ثبت شعبهٔ جدید">
            <input
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="مثلاً: شعبهٔ ونک"
            />
          </Field>
        </div>
        <div className="mb-4">
          <PrimaryButton disabled={busy || !name.trim()}>ثبت و صدور توکن</PrimaryButton>
        </div>
      </form>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// 3. This server's own push target (this server as a "location")
// ---------------------------------------------------------------------------

function LocalSyncCard() {
  const [config, setConfig] = useState<SyncConfig>({ centralUrl: "", token: "", enabled: false });
  const [syncState, setSyncState] = useState<SyncState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api<{ config?: SyncConfig | null; syncState?: SyncState }>("/api/rollup/config");
    if (res.ok) {
      if (res.data.config) setConfig(res.data.config);
      setSyncState(res.data.syncState ?? null);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    setError(null);
    const res = await api<{ error?: string }>("/api/rollup/config", {
      method: "PUT",
      body: JSON.stringify(config),
    });
    setBusy(false);
    if (!res.ok) {
      setError(
        res.data.error === "invalid_url"
          ? "نشانی سرور مرکزی باید با http یا https شروع شود."
          : "برای فعال‌سازی، نشانی سرور مرکزی و توکن هر دو لازم‌اند.",
      );
      return;
    }
    setMessage("ذخیره شد.");
  }

  async function syncNow() {
    setBusy(true);
    setMessage(null);
    setError(null);
    const res = await api<{ result?: { status: string; daysPushed?: number; error?: string } }>(
      "/api/rollup/push",
      { method: "POST" },
    );
    setBusy(false);
    const result = res.data.result;
    if (result?.status === "ok") {
      setMessage(`همگام‌سازی انجام شد (${toPersianDigits(result.daysPushed ?? 0)} روز).`);
    } else if (result?.status === "disabled") {
      setError("همگام‌سازی فعال نیست؛ ابتدا تنظیمات را ذخیره و فعال کنید.");
    } else {
      setError(`همگام‌سازی ناموفق بود: ${result?.error ?? "خطای نامشخص"}`);
    }
    load();
  }

  return (
    <SectionCard title="همگام‌سازی با سرور مرکزی">
      <p className="mb-4 text-sm text-muted-foreground">
        اگر این سرورِ یک شعبه است، نشانی سرور مرکزی و توکن صادرشده برای این شعبه را وارد کنید.
        ارسال هر ۵ دقیقه انجام می‌شود و قطع اینترنت فقط ارسال را عقب می‌اندازد — با اتصال دوباره،
        خودبه‌خود جبران می‌شود.
      </p>

      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {message ? <InfoBox>{message}</InfoBox> : null}

      <form onSubmit={save} className="max-w-xl">
        <Field label="نشانی سرور مرکزی" hint="مثلاً https://central.example.com">
          <input
            dir="ltr"
            className={inputClass}
            value={config.centralUrl}
            onChange={(e) => setConfig({ ...config, centralUrl: e.target.value })}
            placeholder="https://…"
          />
        </Field>
        <Field label="توکن این شعبه">
          <input
            dir="ltr"
            className={inputClass}
            value={config.token}
            onChange={(e) => setConfig({ ...config, token: e.target.value })}
            placeholder="rlk_…"
          />
        </Field>
        <label className="mb-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
          />
          همگام‌سازی فعال باشد
        </label>
        <div className="flex items-center gap-2">
          <PrimaryButton disabled={busy}>ذخیره</PrimaryButton>
          <SecondaryButton onClick={syncNow} disabled={busy}>
            همگام‌سازی هم‌اکنون
          </SecondaryButton>
        </div>
      </form>

      {syncState ? (
        <dl className="mt-4 grid gap-x-8 gap-y-1 border-t pt-4 text-xs text-muted-foreground sm:grid-cols-2">
          <div className="flex justify-between gap-2 sm:justify-start">
            <dt>آخرین ارسال موفق:</dt>
            <dd>{formatSyncTime(syncState.lastSuccessAt)}</dd>
          </div>
          <div className="flex justify-between gap-2 sm:justify-start">
            <dt>آخرین تلاش:</dt>
            <dd>{formatSyncTime(syncState.lastAttemptAt)}</dd>
          </div>
          {syncState.lastError ? (
            <div className="flex justify-between gap-2 text-destructive sm:col-span-2 sm:justify-start">
              <dt>آخرین خطا:</dt>
              <dd dir="ltr">{syncState.lastError}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </SectionCard>
  );
}
