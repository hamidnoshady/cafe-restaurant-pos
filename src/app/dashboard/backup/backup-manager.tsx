"use client";

/**
 * Backup dashboard (Phase 10). Two cards:
 *  1. Status — health badges, last successful local/cloud backup, a manual
 *     «پشتیبان‌گیری هم‌اکنون» button, and the recent run history.
 *  2. Settings (Owner only) — schedule/retention plus the cloud target.
 *     Secrets are write-only: the server never echoes them back, an empty
 *     field on save means "keep the stored value".
 */
import { useCallback, useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { ErrorBox, Field, InfoBox, PrimaryButton, api, inputClass } from "../ui";
import { Button } from "@/components/ui/button";
import { SectionCard, StatusBadge } from "../page-chrome";

interface Health {
  enabled: boolean;
  cloudEnabled: boolean;
  intervalHours: number;
  localLastSuccessAt: string | null;
  localLastError: string | null;
  cloudLastSuccessAt: string | null;
  cloudLastError: string | null;
  alert: { level: "ok" | "warning" | "error"; reason: string };
}

interface RunRow {
  id: string;
  kind: "local" | "cloud";
  trigger: "scheduled" | "manual";
  status: "running" | "success" | "failed";
  artifact: string | null;
  sizeBytes: number | null;
  error: string | null;
  startedAt: string;
}

interface CloudForm {
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  passphrase: string;
  retention: number;
  hasSecretAccessKey?: boolean;
  hasPassphrase?: boolean;
}

interface ConfigForm {
  enabled: boolean;
  intervalHours: number;
  anchorTime: string;
  localRetention: number;
  directory: string;
  cloud: CloudForm;
}

const ALERT_LABELS: Record<string, string> = {
  ok: "سالم",
  disabled: "پشتیبان‌گیری خودکار غیرفعال است",
  local_failed: "آخرین پشتیبان‌گیری محلی ناموفق بود",
  local_stale: "مدت زیادی از آخرین پشتیبان محلی موفق گذشته است",
  cloud_failed: "آخرین بارگذاری ابری ناموفق بود",
  cloud_stale: "مدت زیادی از آخرین پشتیبان ابری موفق گذشته است",
};

const CONFIG_ERRORS: Record<string, string> = {
  invalid_interval: "بازهٔ پشتیبان‌گیری نامعتبر است.",
  invalid_anchor_time: "ساعت پشتیبان‌گیری نامعتبر است.",
  invalid_local_retention: "تعداد نگهداری نسخه‌های محلی باید بین ۱ تا ۳۶۵ باشد.",
  invalid_cloud_retention: "تعداد نگهداری نسخه‌های ابری باید بین ۱ تا ۳۶۵ باشد.",
  invalid_cloud_endpoint: "نشانی فضای ابری باید با http یا https شروع شود.",
  invalid_cloud_prefix: "پیشوند نباید با / شروع شود.",
  missing_cloud_bucket: "نام باکت را وارد کنید.",
  missing_cloud_credentials: "کلید دسترسی و کلید محرمانه هر دو لازم‌اند.",
  weak_passphrase: "عبارت عبور رمزنگاری باید دست‌کم ۸ نویسه باشد.",
  invalid_directory: "مسیر پوشهٔ پشتیبان‌گیری نامعتبر است.",
  cloud_backup_unavailable_local: "در نصب محلی، پشتیبان‌گیری ابری در دسترس نیست.",
};

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

function formatSize(bytes: number | null): string {
  if (bytes === null) return "—";
  const mb = bytes / (1024 * 1024);
  return toPersianDigits(mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`);
}

function RunStatus({ status }: { status: RunRow["status"] }) {
  if (status === "success") return <StatusBadge tone="positive">موفق</StatusBadge>;
  if (status === "failed") return <StatusBadge tone="danger">ناموفق</StatusBadge>;
  return <StatusBadge tone="active">در حال اجرا</StatusBadge>;
}

export function BackupManager({ isOwner }: { isOwner: boolean }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [runs, setRuns] = useState<RunRow[] | null>(null);

  const loadStatus = useCallback(async () => {
    const res = await api<{ health?: Health; runs?: RunRow[] }>("/api/backup/status");
    if (res.ok) {
      setHealth(res.data.health ?? null);
      setRuns(res.data.runs ?? []);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  return (
    <div className="space-y-6">
      <StatusCard health={health} runs={runs} onChanged={loadStatus} />
      {isOwner ? <ExportCard /> : null}
      {isOwner ? <SettingsCard onSaved={loadStatus} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-tenant export (Phase 17, Owner only)
// ---------------------------------------------------------------------------

async function downloadExport(format: "sql" | "xlsx"): Promise<string | null> {
  const res = await fetch(`/api/backup/export?format=${format}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    return data.error ?? "دریافت خروجی ناموفق بود.";
  }
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(disposition);
  const filename = match ? match[1] : `business-export.${format}`;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return null;
}

function ExportCard() {
  const [busy, setBusy] = useState<"sql" | "xlsx" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(format: "sql" | "xlsx") {
    setBusy(format);
    setError(null);
    const err = await downloadExport(format);
    if (err) setError(err);
    setBusy(null);
  }

  return (
    <SectionCard title="خروجی اطلاعات کسب‌وکار">
      <p className="mb-4 text-sm text-muted-foreground">
        تمام اطلاعات این کسب‌وکار (سفارش‌ها، انبار، حساب‌ها، اعضا و غیره) را دریافت کنید — جدا از
        سایر کسب‌وکارهای این سامانه. فایل SQL برای بازگردانی در پایگاه‌دادهٔ دیگر و فایل اکسل برای
        مشاهده و بایگانی مناسب است.
      </p>
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      <div className="flex flex-wrap gap-3">
        <PrimaryButton type="button" disabled={busy !== null} onClick={() => run("sql")}>
          {busy === "sql" ? "در حال آماده‌سازی…" : "دریافت خروجی SQL"}
        </PrimaryButton>
        <PrimaryButton type="button" disabled={busy !== null} onClick={() => run("xlsx")}>
          {busy === "xlsx" ? "در حال آماده‌سازی…" : "دریافت خروجی اکسل"}
        </PrimaryButton>
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// 1. Status + manual backup + history
// ---------------------------------------------------------------------------

function StatusCard({
  health,
  runs,
  onChanged,
}: {
  health: Health | null;
  runs: RunRow[] | null;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function backupNow() {
    setBusy(true);
    setMessage(null);
    setError(null);
    const res = await api<{
      result?: {
        local: { status: string; artifact?: string; error?: string };
        cloud: { status: string; error?: string };
      };
    }>("/api/backup/run", { method: "POST" });
    setBusy(false);
    const result = res.data.result;
    if (result?.local.status === "ok") {
      if (result.cloud.status === "ok") setMessage("پشتیبان محلی و ابری با موفقیت ساخته شد.");
      else if (result.cloud.status === "disabled") setMessage("پشتیبان محلی با موفقیت ساخته شد.");
      else setError(`پشتیبان محلی ساخته شد اما بارگذاری ابری ناموفق بود: ${result.cloud.error ?? ""}`);
    } else if (result?.local.status === "busy") {
      setError("یک پشتیبان‌گیری دیگر در حال اجراست؛ کمی بعد دوباره تلاش کنید.");
    } else {
      setError(`پشتیبان‌گیری ناموفق بود: ${result?.local.error ?? "خطای نامشخص"}`);
    }
    onChanged();
  }

  return (
    <SectionCard
      title="وضعیت پشتیبان‌گیری"
      actions={
        <Button type="button" onClick={backupNow} disabled={busy}>
          {busy ? "در حال پشتیبان‌گیری…" : "پشتیبان‌گیری هم‌اکنون"}
        </Button>
      }
    >
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {message ? <InfoBox>{message}</InfoBox> : null}

      {!health ? (
        <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>
      ) : (
        <>
          <div
            className={`mb-4 rounded-xl border px-4 py-3 text-sm ${
              health.alert.level === "ok"
                ? "border-primary/30 bg-primary/5 text-primary"
                : health.alert.level === "warning"
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                  : "border-destructive/40 bg-destructive/10 text-destructive"
            }`}
          >
            {ALERT_LABELS[health.alert.reason] ?? health.alert.reason}
          </div>
          <dl className="grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
            <div className="flex justify-between gap-2 sm:justify-start">
              <dt className="text-muted-foreground">آخرین پشتیبان محلی موفق:</dt>
              <dd>{formatTime(health.localLastSuccessAt)}</dd>
            </div>
            <div className="flex justify-between gap-2 sm:justify-start">
              <dt className="text-muted-foreground">آخرین پشتیبان ابری موفق:</dt>
              <dd>{health.cloudEnabled ? formatTime(health.cloudLastSuccessAt) : "غیرفعال"}</dd>
            </div>
          </dl>
        </>
      )}

      <h3 className="mb-2 mt-6 text-sm font-medium text-muted-foreground">اجراهای اخیر</h3>
      {!runs ? (
        <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>
      ) : runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">هنوز پشتیبانی گرفته نشده است.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th className="py-2 text-start font-medium">زمان</th>
                <th className="py-2 text-start font-medium">نوع</th>
                <th className="py-2 text-start font-medium">شروع</th>
                <th className="py-2 text-start font-medium">حجم</th>
                <th className="py-2 text-start font-medium">وضعیت</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-b align-top last:border-0">
                  <td className="py-2">{formatTime(r.startedAt)}</td>
                  <td className="py-2">{r.kind === "local" ? "محلی" : "ابری"}</td>
                  <td className="py-2">{r.trigger === "scheduled" ? "زمان‌بندی" : "دستی"}</td>
                  <td className="py-2 tabular-nums">{formatSize(r.sizeBytes)}</td>
                  <td className="py-2">
                    <RunStatus status={r.status} />
                    {r.error ? (
                      <p dir="ltr" className="mt-1 max-w-xs truncate text-xs text-destructive" title={r.error}>
                        {r.error}
                      </p>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// 2. Settings (Owner only)
// ---------------------------------------------------------------------------

const INTERVAL_OPTIONS = [
  { value: 24, label: "شبانه (هر ۲۴ ساعت)" },
  { value: 12, label: "هر ۱۲ ساعت" },
  { value: 8, label: "هر ۸ ساعت" },
  { value: 6, label: "هر ۶ ساعت" },
  { value: 4, label: "هر ۴ ساعت" },
  { value: 2, label: "هر ۲ ساعت" },
  { value: 1, label: "هر ساعت" },
];

function SettingsCard({ onSaved }: { onSaved: () => void }) {
  const [config, setConfig] = useState<ConfigForm | null>(null);
  const [localOnly, setLocalOnly] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await api<{ config?: ConfigForm; localOnly?: boolean }>("/api/backup/config");
      if (res.ok && res.data.config) setConfig(res.data.config);
      if (res.ok) setLocalOnly(Boolean(res.data.localOnly));
    })();
  }, []);

  if (!config) {
    return (
      <SectionCard title="تنظیمات پشتیبان‌گیری">
        <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>
      </SectionCard>
    );
  }

  const cloud = config.cloud;
  const setCloud = (patch: Partial<CloudForm>) => setConfig({ ...config, cloud: { ...cloud, ...patch } });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    setError(null);
    const res = await api<{ error?: string }>("/api/backup/config", {
      method: "PUT",
      body: JSON.stringify(config),
    });
    setBusy(false);
    if (!res.ok) {
      setError(CONFIG_ERRORS[res.data.error ?? ""] ?? "ذخیرهٔ تنظیمات ناموفق بود.");
      return;
    }
    setMessage("ذخیره شد.");
    onSaved();
  }

  return (
    <SectionCard title="تنظیمات پشتیبان‌گیری">
      <p className="mb-4 text-sm text-muted-foreground">
        {localOnly ? (
          <>
            پشتیبان محلی در پوشهٔ مقصد زیر (و در صورت تنظیم BACKUP_SECONDARY_DIR، روی حافظهٔ دوم
            مثل USB/NAS) ذخیره می‌شود.
          </>
        ) : (
          <>
            پشتیبان محلی در پوشهٔ backups سرور (و در صورت تنظیم BACKUP_SECONDARY_DIR، روی حافظهٔ
            دوم مثل USB/NAS) ذخیره می‌شود. نسخهٔ ابری پیش از بارگذاری با عبارت عبور شما رمزنگاری
            می‌شود — بدون آن، بازگردانی از نسخهٔ ابری ممکن نیست؛ آن را جای امنی نگه دارید.
          </>
        )}
      </p>

      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {message ? <InfoBox>{message}</InfoBox> : null}

      <form onSubmit={save} className="max-w-xl">
        <label className="mb-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
          />
          پشتیبان‌گیری خودکار فعال باشد
        </label>

        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="بازهٔ پشتیبان‌گیری">
            <SearchableSelect
              value={String(config.intervalHours)}
              onChange={(value) => setConfig({ ...config, intervalHours: Number(value) })}
              options={INTERVAL_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))}
            />
          </Field>
          <Field label="ساعت شروع (به وقت محلی)" hint="مثلاً ۰۳:۳۰ بامداد، بعد از بستن روز">
            <input
              type="time"
              dir="ltr"
              className={inputClass}
              value={config.anchorTime}
              onChange={(e) => setConfig({ ...config, anchorTime: e.target.value })}
            />
          </Field>
        </div>
        <Field label="تعداد نسخه‌های محلی نگه‌داشته‌شده" hint="نسخه‌های قدیمی‌تر خودکار حذف می‌شوند">
          <input
            type="number"
            dir="ltr"
            min={1}
            max={365}
            className={inputClass}
            value={config.localRetention}
            onChange={(e) => setConfig({ ...config, localRetention: Number(e.target.value) })}
          />
        </Field>
        <Field
          label="پوشهٔ مقصد"
          hint="خالی بگذارید تا از مسیر پیش‌فرض سرور استفاده شود. ترجیحاً یک درایو دیگر یا حافظهٔ خارجی."
        >
          <input
            dir="ltr"
            className={inputClass}
            value={config.directory}
            onChange={(e) => setConfig({ ...config, directory: e.target.value })}
            placeholder="D:\pos-backups"
          />
        </Field>

        {/* A local-only install has no cloud half at all — see the note below. */}
        {!localOnly ? (
          <>
            <div className="mb-4 mt-6 border-t pt-4">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={cloud.enabled}
                  onChange={(e) => setCloud({ enabled: e.target.checked })}
                />
                پشتیبان ابری (خارج از محل) فعال باشد
              </label>
              <p className="mt-1 text-xs text-muted-foreground">
                هر فضای سازگار با S3 — مثل آروان‌کلاد، Backblaze B2 یا MinIO روی NAS.
              </p>
            </div>

            <Field label="نشانی سرویس (Endpoint)" hint="مثلاً https://s3.ir-thr-at1.arvanstorage.ir">
              <input
                dir="ltr"
                className={inputClass}
                value={cloud.endpoint}
                onChange={(e) => setCloud({ endpoint: e.target.value })}
                placeholder="https://…"
              />
            </Field>
            <div className="grid gap-x-4 sm:grid-cols-2">
              <Field label="باکت (Bucket)">
                <input dir="ltr" className={inputClass} value={cloud.bucket} onChange={(e) => setCloud({ bucket: e.target.value })} />
              </Field>
              <Field label="ناحیه (Region)">
                <input dir="ltr" className={inputClass} value={cloud.region} onChange={(e) => setCloud({ region: e.target.value })} />
              </Field>
              <Field label="کلید دسترسی (Access Key)">
                <input dir="ltr" className={inputClass} value={cloud.accessKeyId} onChange={(e) => setCloud({ accessKeyId: e.target.value })} />
              </Field>
              <Field label="کلید محرمانه (Secret Key)" hint={cloud.hasSecretAccessKey ? "ذخیره شده — برای تغییر، مقدار جدید وارد کنید" : undefined}>
                <input
                  dir="ltr"
                  type="password"
                  className={inputClass}
                  value={cloud.secretAccessKey}
                  onChange={(e) => setCloud({ secretAccessKey: e.target.value })}
                  placeholder={cloud.hasSecretAccessKey ? "••••••••" : ""}
                />
              </Field>
              <Field label="پیشوند مسیر (Prefix)">
                <input dir="ltr" className={inputClass} value={cloud.prefix} onChange={(e) => setCloud({ prefix: e.target.value })} />
              </Field>
              <Field label="تعداد نسخه‌های ابری نگه‌داشته‌شده">
                <input
                  type="number"
                  dir="ltr"
                  min={1}
                  max={365}
                  className={inputClass}
                  value={cloud.retention}
                  onChange={(e) => setCloud({ retention: Number(e.target.value) })}
                />
              </Field>
            </div>
            <Field
              label="عبارت عبور رمزنگاری"
              hint={
                cloud.hasPassphrase
                  ? "ذخیره شده — برای تغییر، مقدار جدید وارد کنید. بدون این عبارت، نسخهٔ ابری قابل بازگردانی نیست."
                  : "دست‌کم ۸ نویسه. بدون این عبارت، نسخهٔ ابری قابل بازگردانی نیست — جای امنی نگه دارید."
              }
            >
              <input
                dir="ltr"
                type="password"
                className={inputClass}
                value={cloud.passphrase}
                onChange={(e) => setCloud({ passphrase: e.target.value })}
                placeholder={cloud.hasPassphrase ? "••••••••" : ""}
              />
            </Field>
          </>
        ) : null}

        {localOnly ? (
          <p className="mb-4 rounded-lg border border-input bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
            این نصب محلی است؛ پشتیبان‌گیری ابری در دسترس نیست. نسخه‌های پشتیبان روی همین دستگاه
            ساخته و نگهداری می‌شوند.
          </p>
        ) : null}

        <PrimaryButton disabled={busy}>ذخیره</PrimaryButton>
      </form>
    </SectionCard>
  );
}
