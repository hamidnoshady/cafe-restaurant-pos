"use client";

/**
 * Phase 15 — the system health dashboard.
 *
 * Migration status, the live connection-pool figures, whether RLS is actually
 * being enforced, the most recent backup per business, and platform-wide
 * counts. Read-only — this is a dashboard, not a control surface.
 *
 * The endpoint answers `{ status: … }` (see /api/platform/system) — the page
 * used to treat the whole body as the status object, which crashed every
 * render. It now unwraps correctly and every block degrades to "—" instead of
 * throwing when a field is missing, so one dead sub-query can never take the
 * whole dashboard down again.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Copy,
  Database,
  RefreshCw,
  ShieldCheck,
  ShieldX,
  TriangleAlert,
} from "lucide-react";
import { formatPersianNumber } from "@/lib/digits";
import { api, errorMessage, ErrorBox, Card, StatCard, InfoBox, fmtDate } from "../ui";

interface SystemStatus {
  migrations?: { filename: string; appliedAt: string }[];
  pendingMigrations?: number;
  pool?: { total: number; idle: number; waiting: number };
  rlsEffective?: boolean;
  backups?: { businessId: string; businessName: string; status: string; ranAt: string | null }[];
  counts?: { businesses: number; platformUsers: number; platformAdmins: number };
}

const AUTO_REFRESH_MS = 60_000;
const MIGRATIONS_PREVIEW = 8;

export default function SystemPage() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [showAllMigrations, setShowAllMigrations] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const { ok, data } = await api<{ status?: SystemStatus; error?: string }>(
      "/api/platform/system",
    );
    if (ok && data.status) {
      setStatus(data.status);
      setLoadedAt(new Date().toISOString());
      setError(null);
    } else {
      setError(errorMessage((data as { error?: string }).error ?? "not_found"));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  if (!status) {
    return (
      <div>
        <h1 className="mb-6 text-xl font-bold">سیستم</h1>
        <ErrorBox>{error}</ErrorBox>
        {!error ? (
          <p className="text-sm text-white/50">در حال بارگذاری وضعیت سامانه…</p>
        ) : (
          <ButtonLikeRetry onClick={() => void load()} />
        )}
      </div>
    );
  }

  const counts = status.counts ?? { businesses: 0, platformUsers: 0, platformAdmins: 0 };
  const pool = status.pool ?? { total: 0, idle: 0, waiting: 0 };
  const migrations = status.migrations ?? [];
  const backups = status.backups ?? [];
  const pending = status.pendingMigrations ?? 0;
  const busy = pool.total - pool.idle;
  const shown = showAllMigrations ? migrations : migrations.slice(0, MIGRATIONS_PREVIEW);

  const copySummary = async () => {
    const text = [
      `کسب‌وکار: ${counts.businesses} | کاربران: ${counts.platformUsers} | مدیران: ${counts.platformAdmins}`,
      `مهاجرت معلق: ${pending} | RLS: ${status?.rlsEffective ? "فعال" : "غیرفعال"}`,
      `استخر اتصال: ${busy}/${pool.total} درگیر، ${pool.waiting} در صف`,
      `برداشت: ${new Date(loadedAt ?? Date.now()).toISOString()}`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked; no-op — the figures are on screen */
    }
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">سیستم</h1>
          <p className="mt-1 text-xs text-white/35">
            {loadedAt ? `آخرین به‌روزرسانی: ${fmtDate(loadedAt)} — هر دقیقه تازه می‌شود.` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void copySummary()}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-white/15 px-3 text-xs text-white/70 transition-colors hover:bg-white/5"
          >
            <Copy className="h-3.5 w-3.5" />
            {copied ? "کپی شد" : "کپی خلاصه"}
          </button>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-white/15 px-3 text-xs text-white/70 transition-colors hover:bg-white/5"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            تازه‌سازی
          </button>
        </div>
      </div>

      {error ? (
        <InfoBox>نمایش آخرین وضعیت موفق؛ تازه‌سازی دوباره تلاش می‌کند. ({error})</InfoBox>
      ) : null}

      {pending > 0 ? (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">
              {formatPersianNumber(pending)} مهاجرت هنوز روی پایگاه‌داده اعمال نشده است؛ کد در حال اجرا
              جلوتر از ساختار داده است.
            </p>
            <p className="mt-1 text-xs text-amber-200/70" dir="ltr">
              npm run db:migrate
            </p>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label="کسب‌وکارها"
          value={formatPersianNumber(counts.businesses)}
          icon={<Database className="h-4 w-4" />}
        />
        <StatCard label="هویت‌های سکو" value={formatPersianNumber(counts.platformUsers)} />
        <StatCard label="مدیران سکو" value={formatPersianNumber(counts.platformAdmins)} />
        <StatCard
          label="ایزوله‌سازی سطری"
          value={status.rlsEffective ? "فعال" : "غیرفعال"}
          tone={status.rlsEffective ? "ok" : "bad"}
          hint={
            status.rlsEffective
              ? "نقش اپراتور superuser نیست"
              : "خطر: داده‌ها ایزوله نمی‌شوند!"
          }
          icon={
            status.rlsEffective ? (
              <ShieldCheck className="h-4 w-4" />
            ) : (
              <ShieldX className="h-4 w-4" />
            )
          }
        />
      </div>

      <Card title="استخر اتصال">
        <div className="mb-2 flex items-end justify-between text-sm">
          <span className="text-white/50">
            {formatPersianNumber(busy)} درگیر از {formatPersianNumber(pool.total)}
          </span>
          <span className={pool.waiting > 0 ? "text-amber-300" : "text-white/40"}>
            {formatPersianNumber(pool.waiting)} در صف انتظار
          </span>
        </div>
        <div className="h-2.5 w-full overflow-hidden rounded-full bg-white/8">
          <div
            className={`h-full rounded-full transition-all ${
              pool.total > 0 && busy / pool.total > 0.85 ? "bg-amber-400" : "bg-sky-400"
            }`}
            style={{ width: `${pool.total > 0 ? Math.min(100, (busy / pool.total) * 100) : 0}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-white/35">
          صفِ غیرصفر یعنی درخواست‌ها پشت اتصال‌ها مانده‌اند — با رشد ترافیک، limit استخر را بالا ببرید.
        </p>
      </Card>

      <Card title="مهاجرت‌های اعمال‌شده">
        {migrations.length === 0 ? (
          <p className="text-sm text-white/50">موردی یافت نشد.</p>
        ) : (
          <>
            <ul className="space-y-1 text-sm">
              {shown.map((m) => (
                <li
                  key={m.filename}
                  className="flex flex-col gap-1 border-b border-white/5 py-2 last:border-0 sm:flex-row sm:items-center sm:justify-between"
                >
                  <span className="break-all text-white/80" dir="ltr">
                    {m.filename}
                  </span>
                  <span className="whitespace-nowrap text-xs text-white/40">{fmtDate(m.appliedAt)}</span>
                </li>
              ))}
            </ul>
            {migrations.length > MIGRATIONS_PREVIEW ? (
              <button
                type="button"
                onClick={() => setShowAllMigrations((v) => !v)}
                className="mt-2 text-xs text-sky-300 hover:underline"
              >
                {showAllMigrations
                  ? "فشرده‌سازی فهرست"
                  : `نمایش همهٔ ${formatPersianNumber(migrations.length)} مورد`}
              </button>
            ) : null}
          </>
        )}
      </Card>

      <Card title="آخرین پشتیبان‌گیری هر کسب‌وکار">
        {backups.length === 0 ? (
          <p className="text-sm text-white/50">پشتیبانی ثبت نشده است.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {backups.map((b) => (
              <li
                key={b.businessId}
                className="flex flex-col gap-2 border-b border-white/5 py-2 last:border-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="text-white/80">{b.businessName}</span>
                <span className="flex flex-wrap items-center gap-2 sm:gap-3">
                  <span
                    className={
                      b.status === "success"
                        ? "rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-300"
                        : b.status === "failed"
                          ? "rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-xs text-red-300"
                          : "rounded-full border border-white/15 px-2 py-0.5 text-xs text-white/50"
                    }
                  >
                    {b.status === "success" ? "موفق" : b.status === "failed" ? "ناموفق" : b.status}
                  </span>
                  <span className="whitespace-nowrap text-xs text-white/40">{fmtDate(b.ranAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function ButtonLikeRetry({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-4 inline-flex h-9 items-center rounded-lg border border-white/15 px-4 text-sm text-white/80 transition-colors hover:bg-white/5"
    >
      تلاش دوباره
    </button>
  );
}
