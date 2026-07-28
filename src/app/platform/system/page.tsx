"use client";

/**
 * Phase 15 — the system health dashboard.
 *
 * Migration status, the live connection-pool figures, whether RLS is actually
 * being enforced, the most recent backup per business, and platform-wide
 * counts. Read-only — this is a dashboard, not a control surface.
 */
import { useEffect, useState } from "react";
import { toPersianDigits, formatPersianNumber } from "@/lib/digits";
import { api, errorMessage, ErrorBox, Card } from "../ui";

interface SystemStatus {
  migrations: { filename: string; appliedAt: string }[];
  pendingMigrations: number;
  pool: { total: number; idle: number; waiting: number };
  rlsEffective: boolean;
  backups: { businessId: string; businessName: string; status: string; ranAt: string | null }[];
  counts: { businesses: number; platformUsers: number; platformAdmins: number };
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

export default function SystemPage() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { ok, data } = await api<{ error?: string } & Partial<SystemStatus>>(
        "/api/platform/system",
      );
      if (ok) setStatus(data as SystemStatus);
      else setError(errorMessage(data.error));
    })();
  }, []);

  if (!status) {
    return (
      <div className="mx-auto w-full max-w-4xl">
        <h1 className="mb-6 text-xl font-bold">سیستم</h1>
        <ErrorBox>{error}</ErrorBox>
        {!error ? <p className="text-sm text-white/50">در حال بارگذاری…</p> : null}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 sm:space-y-6">
      <h1 className="text-xl font-bold">سیستم</h1>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="کسب‌وکارها" value={formatPersianNumber(status.counts.businesses)} />
        <Stat label="هویت‌های سکو" value={formatPersianNumber(status.counts.platformUsers)} />
        <Stat label="مدیران سکو" value={formatPersianNumber(status.counts.platformAdmins)} />
      </div>

      <Card title="سلامت زیرساخت">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <Row label="مهاجرت‌های معلق">
            <span className={status.pendingMigrations > 0 ? "text-amber-300" : "text-emerald-300"}>
              {formatPersianNumber(status.pendingMigrations)}
            </span>
          </Row>
          <Row label="ایزوله‌سازی سطری (RLS)">
            {status.rlsEffective ? (
              <span className="text-emerald-300">فعال</span>
            ) : (
              <span className="text-red-300">غیرفعال</span>
            )}
          </Row>
          <Row label="اتصال‌های استخر (کل)">
            {formatPersianNumber(status.pool.total)}
          </Row>
          <Row label="اتصال‌های بی‌کار">{formatPersianNumber(status.pool.idle)}</Row>
          <Row label="در صف انتظار">{formatPersianNumber(status.pool.waiting)}</Row>
        </dl>
      </Card>

      <Card title="آخرین مهاجرت‌های اعمال‌شده">
        {status.migrations.length === 0 ? (
          <p className="text-sm text-white/50">موردی یافت نشد.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {status.migrations.map((m) => (
              <li
                key={m.filename}
                className="flex flex-col gap-1 border-b border-white/5 py-2 last:border-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="break-all text-white/80" dir="ltr">
                  {m.filename}
                </span>
                <span className="text-xs text-white/40">{fmtDate(m.appliedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="آخرین پشتیبان‌گیری هر کسب‌وکار">
        {status.backups.length === 0 ? (
          <p className="text-sm text-white/50">پشتیبانی ثبت نشده است.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {status.backups.map((b) => (
              <li
                key={b.businessId}
                className="flex flex-col gap-2 border-b border-white/5 py-2 last:border-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="text-white/80">{b.businessName}</span>
                <span className="flex flex-wrap items-center gap-2 sm:gap-3">
                  <span
                    className={
                      b.status === "success"
                        ? "text-emerald-300"
                        : b.status === "failed"
                          ? "text-red-300"
                          : "text-white/50"
                    }
                  >
                    {b.status}
                  </span>
                  <span className="text-xs text-white/40">{fmtDate(b.ranAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/2 p-4">
      <p className="text-xs text-white/40">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-white/5 pb-2 sm:flex-row sm:items-center sm:justify-between">
      <dt className="text-white/50">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}
