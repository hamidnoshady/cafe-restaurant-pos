"use client";

/**
 * Owner-only settings for the bidirectional server-to-server sync (Phase 11):
 * connects this server to a remote peer (café laptop <-> VPS) and reuses the
 * client offline-queue's idempotency engine. Previously only reachable via
 * PUT /api/server-sync/config directly (see docs/server-sync.md, which
 * already documented a "Settings → Server Sync" page that didn't exist yet).
 */
import { useCallback, useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { ErrorBox, Field, InfoBox, PrimaryButton, api, errorMessage, inputClass } from "../ui";

interface ConfigView {
  remoteUrl: string;
  /** masked preview, e.g. "a3f8…9d21" — never the real secret */
  token: string;
  enabled: boolean;
  batchSize?: number;
}

interface StateView {
  lastPushedEventId: number | null;
  lastPulledEventId: number | null;
  lastPushAttemptAt: string | null;
  lastPullAttemptAt: string | null;
  lastPushSuccessAt: string | null;
  lastPullSuccessAt: string | null;
  lastPushError: string | null;
  lastPullError: string | null;
}

interface DeadLetter {
  id: number;
  remoteEventId: number;
  locationId: string;
  clientEventId: string;
  eventType: string;
  error: string;
  createdAt: string;
}

function formatTime(iso: string | null): string {
  if (!iso) return "هرگز";
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tehran",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
  return `${toPersianDigits(formatJalali(iso))} ${toPersianDigits(time)}`;
}

function StatusRow({ label, value, tone }: { label: string; value: string; tone?: "error" }) {
  return (
    <div className="flex items-center justify-between border-b border-border/60 py-2 text-sm last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className={tone === "error" ? "font-medium text-destructive" : "font-medium"}>{value}</span>
    </div>
  );
}

export function ServerSyncSettings() {
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [syncState, setSyncState] = useState<StateView | null>(null);
  const [deadLetters, setDeadLetters] = useState<DeadLetter[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [remoteUrl, setRemoteUrl] = useState("");
  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [batchSize, setBatchSize] = useState("100");

  const load = useCallback(async () => {
    setLoading(true);
    const { ok, data } = await api<{
      config: ConfigView | null;
      syncState: StateView;
      deadLetters: DeadLetter[];
      error?: string;
    }>("/api/server-sync/config");
    if (ok) {
      setConfig(data.config);
      setSyncState(data.syncState);
      setDeadLetters(data.deadLetters ?? []);
      setRemoteUrl(data.config?.remoteUrl ?? "");
      setEnabled(data.config?.enabled ?? false);
      setBatchSize(String(data.config?.batchSize ?? 100));
      setToken("");
      setError("");
    } else {
      setError(errorMessage(data.error));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    const body: Record<string, unknown> = {
      remoteUrl,
      enabled,
      batchSize: Number(batchSize),
    };
    // Only send `token` when the owner actually typed a new one — the server
    // keeps the existing token otherwise (see resolveConfigUpdate).
    if (token) body.token = token;

    const { ok, data } = await api<{ error?: string }>("/api/server-sync/config", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error) || data.error || "خطای غیرمنتظره.");
      return;
    }
    setNotice("تنظیمات همگام‌سازی ذخیره شد.");
    await load();
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>;
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="mb-1 font-semibold">اتصال به سرور راه دور</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          این سرور (مثلاً لپ‌تاپ کافه) با یک سرور مرکزی (VPS) به‌صورت دوطرفه همگام می‌شود. توکن مشترک باید در هر دو
          سمت یکسان باشد.
        </p>
        <ErrorBox>{error}</ErrorBox>
        {notice ? <InfoBox>{notice}</InfoBox> : null}
        <form onSubmit={save}>
          <Field label="آدرس سرور مرکزی" hint="مثلاً https://pos.eshobe.com">
            <input
              className={inputClass}
              value={remoteUrl}
              onChange={(e) => setRemoteUrl(e.target.value)}
              placeholder="https://pos.eshobe.com"
              dir="ltr"
            />
          </Field>
          <Field
            label="توکن مشترک"
            hint={config?.token ? `توکن فعلی: ${config.token} — برای تغییر، توکن جدید وارد کنید` : "با openssl rand -hex 32 بسازید"}
          >
            <input
              className={inputClass}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={config?.token ? "برای حفظ توکن فعلی خالی بگذارید" : ""}
              dir="ltr"
              type="password"
              autoComplete="off"
            />
          </Field>
          <Field label="تعداد رویداد در هر دسته">
            <input
              className={inputClass}
              value={batchSize}
              onChange={(e) => setBatchSize(e.target.value)}
              type="number"
              min={1}
              max={200}
              dir="ltr"
            />
          </Field>
          <label className="mb-4 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            همگام‌سازی فعال باشد
          </label>
          <PrimaryButton disabled={busy}>{busy ? "در حال ذخیره…" : "ذخیره تنظیمات"}</PrimaryButton>
        </form>
      </section>

      {syncState ? (
        <section className="rounded-2xl bg-card p-5 shadow-sm">
          <h2 className="mb-3 font-semibold">وضعیت همگام‌سازی</h2>
          <div className="grid gap-x-8 sm:grid-cols-2">
            <div>
              <h3 className="mb-1 text-sm font-medium text-muted-foreground">ارسال (Push)</h3>
              <StatusRow label="آخرین تلاش" value={formatTime(syncState.lastPushAttemptAt)} />
              <StatusRow label="آخرین موفقیت" value={formatTime(syncState.lastPushSuccessAt)} />
              <StatusRow
                label="آخرین خطا"
                value={syncState.lastPushError ?? "—"}
                tone={syncState.lastPushError ? "error" : undefined}
              />
            </div>
            <div>
              <h3 className="mb-1 text-sm font-medium text-muted-foreground">دریافت (Pull)</h3>
              <StatusRow label="آخرین تلاش" value={formatTime(syncState.lastPullAttemptAt)} />
              <StatusRow label="آخرین موفقیت" value={formatTime(syncState.lastPullSuccessAt)} />
              <StatusRow
                label="آخرین خطا"
                value={syncState.lastPullError ?? "—"}
                tone={syncState.lastPullError ? "error" : undefined}
              />
            </div>
          </div>
        </section>
      ) : null}

      <section className="rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="mb-1 font-semibold">رویدادهای ناموفق</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          رویدادهایی که هنگام دریافت از سرور مرکزی اعمال نشدند و برای بررسی نگه داشته شده‌اند.
        </p>
        {deadLetters.length === 0 ? (
          <p className="text-sm text-muted-foreground">رویداد ناموفقی ثبت نشده است.</p>
        ) : (
          <div className="space-y-2">
            {deadLetters.map((dl) => (
              <div key={dl.id} className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{dl.eventType}</span>
                  <span className="text-xs text-muted-foreground">{formatTime(dl.createdAt)}</span>
                </div>
                <p className="mt-1 text-xs text-destructive">{dl.error}</p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
