"use client";

/**
 * «رسانه و فایل‌ها» — the console's media-storage panel (migration 0149).
 *
 * Three cards, in the order the operator meets them:
 *
 *   ۱ وضعیت    — how many businesses store how much, and whether the bucket answers.
 *   ۲ اتصال    — the S3/Parspack connection (endpoint, bucket, prefix, credentials)
 *                with «آزمایش اتصال» that writes and deletes a probe object.
 *   ۳ تعرفه    — the daily price policy: flat base + per-GB above a free quota,
 *                and the price of one AI product-image refine.
 *
 * The secret key never comes back from the server (`secretAccessKeySet` only):
 * an untouched field keeps the stored secret, typing replaces it.
 */
import { useCallback, useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import {
  api,
  Button,
  Card,
  ErrorBox,
  Field,
  InfoBox,
  inputClass,
  SkeletonRows,
  StatCard,
  useCan,
} from "../ui";

interface MaskedConfig {
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  keyPrefix: string;
  accessKeyId: string;
  secretAccessKeySet: boolean;
  billingEnabled: boolean;
  dailyFlatRial: number;
  dailyPerGbRial: number;
  freeQuotaMb: number;
  enhanceModel: string;
  enhancePriceRial: number;
}

interface Usage {
  businesses: number;
  assets: number;
  bytes: number;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${toPersianDigits((bytes / (1024 * 1024 * 1024)).toFixed(2))} گیگابایت`;
  if (bytes >= 1024 * 1024) return `${toPersianDigits((bytes / (1024 * 1024)).toFixed(1))} مگابایت`;
  return `${toPersianDigits(Math.max(1, Math.round(bytes / 1024)))} کیلوبایت`;
}

const ERRORS: Record<string, string> = {
  endpoint_required: "برای فعال‌سازی، آدرس سرویس S3 لازم است.",
  endpoint_invalid: "آدرس سرویس S3 معتبر نیست (باید با https شروع شود).",
  bucket_required: "نام باکت لازم است.",
  credentials_required: "کلید دسترسی و کلید محرمانه هر دو لازم‌اند.",
  invalid_price: "مقادیر تعرفه باید عدد صفر یا بزرگ‌تر باشند.",
};

export function MediaConsoleManager() {
  const can = useCan();
  const canManage = can("media.manage");

  const [config, setConfig] = useState<MaskedConfig | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [secret, setSecret] = useState(""); // typed replacement only
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<"" | "ok" | "failed">("");

  const load = useCallback(() => {
    api<{ config: MaskedConfig; usage: Usage }>("/api/platform/media").then(({ ok, data }) => {
      if (ok) {
        setConfig(data.config);
        setUsage(data.usage);
      } else setError("خواندن تنظیمات ناموفق بود.");
    });
  }, []);
  useEffect(load, [load]);

  function patch(update: Partial<MaskedConfig>) {
    setConfig((c) => (c ? { ...c, ...update } : c));
  }

  async function save() {
    if (!config) return;
    setBusy(true);
    setError("");
    setNotice("");
    const body: Record<string, unknown> = {
      enabled: config.enabled,
      endpoint: config.endpoint,
      region: config.region,
      bucket: config.bucket,
      keyPrefix: config.keyPrefix,
      accessKeyId: config.accessKeyId,
      billingEnabled: config.billingEnabled,
      dailyFlatRial: config.dailyFlatRial,
      dailyPerGbRial: config.dailyPerGbRial,
      freeQuotaMb: config.freeQuotaMb,
      enhanceModel: config.enhanceModel,
      enhancePriceRial: config.enhancePriceRial,
    };
    if (secret) body.secretAccessKey = secret; // omitted = keep stored
    const { ok, data } = await api<{ config?: MaskedConfig; error?: string }>("/api/platform/media", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!ok) {
      setError(ERRORS[data.error ?? ""] ?? "ذخیره ناموفق بود.");
      return;
    }
    if (data.config) setConfig(data.config);
    setSecret("");
    setNotice("تنظیمات ذخیره شد.");
  }

  async function testConnection() {
    setBusy(true);
    setTestResult("");
    setError("");
    const { ok, data } = await api<{ detail?: string }>("/api/platform/media/test", { method: "POST" });
    setBusy(false);
    setTestResult(ok ? "ok" : "failed");
    if (!ok && data.detail) setError(`اتصال برقرار نشد: ${data.detail}`);
  }

  if (!config) {
    return (
      <div className="space-y-4">
        <Card title="رسانه و فایل‌ها">
          <SkeletonRows rows={6} />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ۱ — وضعیت */}
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="کسب‌وکارهای دارای فایل" value={toPersianDigits(usage?.businesses ?? 0)} />
        <StatCard label="تعداد فایل‌ها" value={toPersianDigits(usage?.assets ?? 0)} />
        <StatCard label="حجم کل ذخیره‌شده" value={usage ? formatBytes(usage.bytes) : "—"} />
      </div>

      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {notice ? <InfoBox>{notice}</InfoBox> : null}
      {testResult === "ok" ? <InfoBox>اتصال به فضای ذخیره‌سازی با موفقیت آزمایش شد.</InfoBox> : null}

      {/* ۲ — اتصال */}
      <Card title="اتصال فضای ذخیره‌سازی (S3 سازگار — پارس‌پک، آروان، MinIO و …)">
        <label className="mb-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={config.enabled}
            disabled={!canManage}
            onChange={(e) => patch({ enabled: e.target.checked })}
            className="size-4"
          />
          کتابخانهٔ رسانه برای کسب‌وکارها فعال باشد
        </label>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="آدرس سرویس (Endpoint)">
            <input
              className={inputClass}
              dir="ltr"
              value={config.endpoint}
              disabled={!canManage}
              onChange={(e) => patch({ endpoint: e.target.value })}
              placeholder="https://s3.parspack.com"
            />
          </Field>
          <Field label="ناحیه (Region)">
            <input
              className={inputClass}
              dir="ltr"
              value={config.region}
              disabled={!canManage}
              onChange={(e) => patch({ region: e.target.value })}
            />
          </Field>
          <Field label="باکت (Bucket)">
            <input
              className={inputClass}
              dir="ltr"
              value={config.bucket}
              disabled={!canManage}
              onChange={(e) => patch({ bucket: e.target.value })}
            />
          </Field>
          <Field
            label="پیشوند کلیدها (Prefix)"
            hint="جداسازی مستأجرها داخل همین پیشوند با شناسهٔ کسب‌وکار انجام می‌شود؛ هر کسب‌وکار فقط زیر پیشوند خودش خوانده و نوشته می‌شود."
          >
            <input
              className={inputClass}
              dir="ltr"
              value={config.keyPrefix}
              disabled={!canManage}
              onChange={(e) => patch({ keyPrefix: e.target.value })}
            />
          </Field>
          <Field label="کلید دسترسی (Access Key)">
            <input
              className={inputClass}
              dir="ltr"
              value={config.accessKeyId}
              disabled={!canManage}
              onChange={(e) => patch({ accessKeyId: e.target.value })}
            />
          </Field>
          <Field
            label="کلید محرمانه (Secret Key)"
            hint={config.secretAccessKeySet ? "کلیدی ذخیره شده است؛ برای تعویض تایپ کنید." : "هنوز کلیدی ذخیره نشده است."}
          >
            <input
              className={inputClass}
              dir="ltr"
              type="password"
              value={secret}
              disabled={!canManage}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={config.secretAccessKeySet ? "••••••••" : ""}
            />
          </Field>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={save} disabled={!canManage || busy}>
            {busy ? "در حال ذخیره…" : "ذخیرهٔ تنظیمات"}
          </Button>
          <Button variant="ghost" onClick={testConnection} disabled={!canManage || busy}>
            آزمایش اتصال
          </Button>
        </div>
      </Card>

      {/* ۳ — تعرفه */}
      <Card title="تعرفهٔ نگهداری روزانه">
        <p className="mb-4 text-sm text-muted-foreground">
          هزینهٔ نگهداری هر روز یک بار از کیف پول هر کسب‌وکاری که فایلی ذخیره کرده کسر می‌شود: یک مبلغ پایهٔ ثابت
          به‌علاوهٔ نرخ حجمی به‌ازای هر گیگابایت مازاد بر سهمیهٔ رایگان. مقادیر به ریال است؛ صفر یعنی رایگان.
        </p>
        <label className="mb-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={config.billingEnabled}
            disabled={!canManage}
            onChange={(e) => patch({ billingEnabled: e.target.checked })}
            className="size-4"
          />
          کسر هزینهٔ روزانه فعال باشد
        </label>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="مبلغ پایهٔ روزانه (ریال)">
            <input
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={String(config.dailyFlatRial)}
              disabled={!canManage}
              onChange={(e) => patch({ dailyFlatRial: Number(e.target.value.replace(/[^\d]/g, "")) || 0 })}
            />
          </Field>
          <Field label="نرخ روزانهٔ هر گیگابایت (ریال)">
            <input
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={String(config.dailyPerGbRial)}
              disabled={!canManage}
              onChange={(e) => patch({ dailyPerGbRial: Number(e.target.value.replace(/[^\d]/g, "")) || 0 })}
            />
          </Field>
          <Field label="سهمیهٔ رایگان (مگابایت)">
            <input
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={String(config.freeQuotaMb)}
              disabled={!canManage}
              onChange={(e) => patch({ freeQuotaMb: Number(e.target.value.replace(/[^\d]/g, "")) || 0 })}
            />
          </Field>
          <Field label="قیمت هر بهینه‌سازی تصویر محصول (ریال)" hint="تولید تصویر استاندارد با پس‌زمینهٔ سفید توسط هوش مصنوعی">
            <input
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={String(config.enhancePriceRial)}
              disabled={!canManage}
              onChange={(e) => patch({ enhancePriceRial: Number(e.target.value.replace(/[^\d]/g, "")) || 0 })}
            />
          </Field>
          <Field label="مدل ویرایش تصویر" hint="نام مدلی که درگاه هوش مصنوعی برای ویرایش تصویر می‌شناسد">
            <input
              className={inputClass}
              dir="ltr"
              value={config.enhanceModel}
              disabled={!canManage}
              onChange={(e) => patch({ enhanceModel: e.target.value })}
            />
          </Field>
        </div>
        <Button onClick={save} disabled={!canManage || busy}>
          {busy ? "در حال ذخیره…" : "ذخیرهٔ تعرفه"}
        </Button>
      </Card>
    </div>
  );
}
