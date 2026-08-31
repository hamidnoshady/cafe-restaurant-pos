"use client";

/**
 * Super-admin surface for the desktop installer's self-update (see
 * docs/standalone-desktop-app.md): the S3-compatible bucket electron-updater
 * checks, and which businesses' on-site installs are current vs behind.
 *
 * Cross-business client supervision like this belongs here, not in any
 * per-business dashboard — see CLAUDE.md.
 */
import { useCallback, useEffect, useState } from "react";
import { toPersianDigits, formatPersianNumber } from "@/lib/digits";
import { api, errorMessage, useCan, ErrorBox, InfoBox, Card, Field, Button, inputClass, PlatformPageSkeleton } from "../ui";

interface ConfigView {
  s3Endpoint: string;
  s3Bucket: string;
  s3AccessKeyId: string;
  /** masked preview, e.g. "a3f8…9d21" — never the real secret */
  s3SecretAccessKey: string;
  publicBaseUrl: string;
}

interface ClientStatus {
  businessId: string;
  businessName: string;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  error: string | null;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return toPersianDigits(
      new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)),
    );
  } catch {
    return iso;
  }
}

function ComplianceBadge({ client }: { client: ClientStatus }) {
  if (client.error) {
    return (
      <span className="inline-block rounded-full border border-red-500/30 bg-red-500/15 px-2.5 py-0.5 text-xs font-medium text-red-300">
        خطا
      </span>
    );
  }
  if (client.updateAvailable) {
    return (
      <span className="inline-block rounded-full border border-amber-500/30 bg-amber-500/15 px-2.5 py-0.5 text-xs font-medium text-amber-300">
        نسخهٔ جدید در دسترس
      </span>
    );
  }
  return (
    <span className="inline-block rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2.5 py-0.5 text-xs font-medium text-emerald-300">
      به‌روز
    </span>
  );
}

export default function UpdatesPage() {
  const can = useCan();
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [clients, setClients] = useState<ClientStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [s3Endpoint, setS3Endpoint] = useState("");
  const [s3Bucket, setS3Bucket] = useState("");
  const [s3AccessKeyId, setS3AccessKeyId] = useState("");
  const [s3SecretAccessKey, setS3SecretAccessKey] = useState("");
  const [publicBaseUrl, setPublicBaseUrl] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const { ok, data } = await api<{ config: ConfigView | null; clients: ClientStatus[]; error?: string }>(
      "/api/platform/updates",
    );
    if (ok) {
      setConfig(data.config);
      setClients(data.clients ?? []);
      setS3Endpoint(data.config?.s3Endpoint ?? "");
      setS3Bucket(data.config?.s3Bucket ?? "");
      setS3AccessKeyId(data.config?.s3AccessKeyId ?? "");
      setPublicBaseUrl(data.config?.publicBaseUrl ?? "");
      setS3SecretAccessKey("");
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
    const body: Record<string, unknown> = { s3Endpoint, s3Bucket, s3AccessKeyId, publicBaseUrl };
    if (s3SecretAccessKey) body.s3SecretAccessKey = s3SecretAccessKey;

    const { ok, data } = await api<{ error?: string }>("/api/platform/updates", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error) || data.error || "خطای غیرمنتظره.");
      return;
    }
    setNotice("تنظیمات به‌روزرسانی ذخیره شد.");
    await load();
  }

  if (loading) return <PlatformPageSkeleton />;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 sm:space-y-6">
      <h1 className="text-xl font-bold">به‌روزرسانی نصب‌های محلی</h1>
      <ErrorBox>{error}</ErrorBox>
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      <Card title="محل توزیع نصب‌کنندهٔ دسکتاپ">
        <p className="mb-4 text-sm text-white/50">
          سطل ذخیره‌سازی سازگار با S3 که برنامهٔ دسکتاپ (Electron) برای بررسی و دریافت نسخهٔ جدید بررسی می‌کند. این
          سطل باید عمومی‌خوان باشد — چیزی حساس (رمز عبور، کلید JWT) هرگز داخل فایل نصب نیست. جزئیات:
          docs/standalone-desktop-app.md
        </p>
        {!can("updates.manage") ? (
          <InfoBox>فقط مدیر ارشد (owner) می‌تواند این تنظیمات را تغییر دهد. نمایش فقط‌خواندنی است.</InfoBox>
        ) : null}
        <form onSubmit={save}>
          <Field label="نشانی Endpoint" hint="مثلاً https://s3.ir-thr-at1.arvanstorage.ir">
            <input
              className={inputClass}
              value={s3Endpoint}
              onChange={(e) => setS3Endpoint(e.target.value)}
              placeholder="https://..."
              dir="ltr"
              disabled={!can("updates.manage")}
            />
          </Field>
          <Field label="نام سطل (Bucket)">
            <input
              className={inputClass}
              value={s3Bucket}
              onChange={(e) => setS3Bucket(e.target.value)}
              dir="ltr"
              disabled={!can("updates.manage")}
            />
          </Field>
          <Field label="Access Key ID">
            <input
              className={inputClass}
              value={s3AccessKeyId}
              onChange={(e) => setS3AccessKeyId(e.target.value)}
              dir="ltr"
              disabled={!can("updates.manage")}
            />
          </Field>
          <Field
            label="Secret Access Key"
            hint={
              config?.s3SecretAccessKey
                ? `کلید فعلی: ${config.s3SecretAccessKey} — برای تغییر، کلید جدید وارد کنید`
                : "برای این سطل، کلید مخفی را وارد کنید"
            }
          >
            <input
              className={inputClass}
              value={s3SecretAccessKey}
              onChange={(e) => setS3SecretAccessKey(e.target.value)}
              placeholder={config?.s3SecretAccessKey ? "برای حفظ کلید فعلی خالی بگذارید" : ""}
              dir="ltr"
              type="password"
              autoComplete="off"
              disabled={!can("updates.manage")}
            />
          </Field>
          <Field label="نشانی عمومی پایه" hint="نشانی HTTPS که فایل‌های نصب از آن در دسترس عموم است">
            <input
              className={inputClass}
              value={publicBaseUrl}
              onChange={(e) => setPublicBaseUrl(e.target.value)}
              placeholder="https://..."
              dir="ltr"
              disabled={!can("updates.manage")}
            />
          </Field>
          {can("updates.manage") ? (
            <Button type="submit" disabled={busy}>
              {busy ? "در حال ذخیره…" : "ذخیره تنظیمات"}
            </Button>
          ) : null}
        </form>
      </Card>

      <Card title="وضعیت نسخهٔ نصب‌های محلی هر کسب‌وکار">
        <p className="mb-4 text-sm text-white/50">
          فقط کسب‌وکارهایی که همگام‌سازی با سرور مرکزی را فعال کرده‌اند اینجا دیده می‌شوند — نصب کاملاً آفلاین
          (بدون هیچ اتصالی) راهی برای گزارش نسخهٔ خود ندارد و در این فهرست ظاهر نمی‌شود.
        </p>
        {clients.length === 0 ? (
          <p className="text-sm text-white/50">هیچ کسب‌وکاری وضعیت به‌روزرسانی گزارش نکرده است.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {clients.map((c) => (
              <li
                key={c.businessId}
                className="flex flex-col gap-2 border-b border-white/5 py-2 last:border-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="text-white/80">{c.businessName}</span>
                <span className="flex flex-wrap items-center gap-2 text-xs sm:gap-3">
                  <span dir="ltr" className="text-white/50">
                    {c.currentVersion || "—"}
                  </span>
                  <ComplianceBadge client={c} />
                  <span className="text-white/40">{fmtDate(c.checkedAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="text-xs text-white/30">
        {formatPersianNumber(clients.length)} کسب‌وکار گزارش‌دهنده.
      </p>
    </div>
  );
}
