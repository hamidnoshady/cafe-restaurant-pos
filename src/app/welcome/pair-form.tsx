"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const DEFAULT_REMOTE_URL = "https://pos.eshobe.com";

/** Every failure this flow can produce, in the owner's language. */
const ERROR_MESSAGES: Record<string, string> = {
  code_not_found: "کد اتصال معتبر نیست.",
  code_expired: "این کد منقضی شده است. از پشتیبانی کد جدید بخواهید.",
  code_already_redeemed: "این کد قبلاً استفاده شده است.",
  code_revoked: "این کد لغو شده است. از پشتیبانی کد جدید بخواهید.",
  remote_unreachable: "سرور آنلاین در دسترس نیست. اتصال اینترنت را بررسی کنید.",
  snapshot_invalid: "داده‌های دریافتی معتبر نیستند. با پشتیبانی تماس بگیرید.",
  missing_fields: "آدرس سرور و کد اتصال را وارد کنید.",
  invalid_url: "آدرس سرور معتبر نیست.",
};

export function PairForm({ onBack }: { onBack: () => void }) {
  const router = useRouter();
  const [remoteUrl, setRemoteUrl] = useState(DEFAULT_REMOTE_URL);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");

    const res = await fetch("/api/setup/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remoteUrl, code }),
    });

    if (res.ok) {
      // The snapshot already carries a completed wizard, so this goes straight
      // to the dashboard rather than /setup/business. Unprefixed: a paired
      // laptop serves one business from its own address, and the dashboard has
      // had no slug in its URL since the path-prefix scheme was retired.
      router.replace("/dashboard");
      return;
    }

    const data = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (data.error === "already_initialized") {
      router.replace("/login");
      return;
    }
    setError(ERROR_MESSAGES[data.error ?? ""] ?? "اتصال انجام نشد. دوباره تلاش کنید.");
  }

  return (
    <div className="w-full max-w-md rounded-2xl bg-card p-8 shadow-sm">
      <button
        type="button"
        onClick={onBack}
        className="mb-4 text-sm text-muted-foreground hover:text-foreground"
      >
        ← بازگشت
      </button>
      <h1 className="mb-1 text-2xl font-bold">اتصال به پلتفرم آنلاین</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        کد اتصال یک‌بارمصرفی است که پشتیبانی برای کسب‌وکار شما صادر می‌کند.
      </p>

      {error ? (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-foreground">آدرس سرور *</span>
          <input
            className="w-full rounded-lg border border-input px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-ring/30"
            dir="ltr"
            value={remoteUrl}
            onChange={(e) => setRemoteUrl(e.target.value)}
            required
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-foreground">کد اتصال *</span>
          <input
            className="w-full rounded-lg border border-input px-3 py-2 text-center font-mono text-lg tracking-widest outline-none focus:border-primary focus:ring-2 focus:ring-ring/30"
            dir="ltr"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="XXXX-XXXX-XXXX"
            autoComplete="off"
            required
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/85 disabled:opacity-50"
        >
          {busy ? "در حال دریافت تنظیمات…" : "اتصال و دریافت تنظیمات"}
        </button>
      </form>
    </div>
  );
}
