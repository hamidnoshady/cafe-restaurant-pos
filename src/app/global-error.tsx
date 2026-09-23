"use client";

import { useEffect, useMemo } from "react";
import localFont from "next/font/local";
import Link from "next/link";
import { CircleAlertIcon, DownloadIcon } from "lucide-react";
import { ThemeProvider } from "@/components/theme-provider";
import { cardClass } from "@/app/dashboard/page-chrome";
import { buildTechnicalReport, exportClientErrorLog, generateErrorId, recordClientError } from "@/lib/error-report";
import "./globals.css";

const vazirmatn = localFont({
  src: "./fonts/Vazirmatn-Variable.woff2",
  variable: "--font-vazirmatn",
  display: "swap",
  weight: "100 900",
});

/**
 * Catches an error in the root layout itself — the one case `error.tsx`
 * cannot cover, because the layout it would render inside is what broke.
 * Next requires this file to render its own `<html>`/`<body>` from scratch,
 * so it re-declares the font and re-imports the global stylesheet rather
 * than relying on `layout.tsx`. Kept deliberately light (no PWA/toaster
 * wiring) since this is the last line of defence — it must not have its own
 * way to fail.
 *
 * Section 12 of the desktop audit: this boundary owns the same obligations
 * as `error.tsx` — a friendly message, a short error ID (generateErrorId,
 * distinct from Next's own `digest`), and an export-logs button — since it
 * is the one boundary error.tsx cannot substitute for. Only the opaque
 * `digest` is ever shown directly on screen; `error.message`/`.stack` only
 * ever leave this component inside the exported, secret-redacted log file.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const errorId = useMemo(() => generateErrorId(error.message || "unknown", Date.now()), [error]);
  const report = useMemo(
    () =>
      buildTechnicalReport({
        errorId,
        message: error.message,
        stack: error.stack,
        digest: error.digest,
        url: typeof window !== "undefined" ? window.location.href : undefined,
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
        appVersion: process.env.NEXT_PUBLIC_APP_VERSION,
      }),
    [error, errorId],
  );

  useEffect(() => {
    console.error(error);
    recordClientError({ errorId, occurredAt: new Date().toISOString(), report });
    // Only once per mounted error instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  function downloadLogs() {
    const full = exportClientErrorLog() || report;
    const blob = new Blob([full], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pos-error-log-${errorId}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <html lang="fa" dir="rtl" className={vazirmatn.variable} suppressHydrationWarning>
      <body className="font-sans">
        <ThemeProvider>
          <main className="flex min-h-screen items-center justify-center p-4">
            <div className={`w-full max-w-sm ${cardClass} p-8 text-center`}>
              <CircleAlertIcon className="mx-auto mb-4 size-10 text-destructive" />
              <h1 className="mb-1 text-xl font-bold">خطای غیرمنتظره</h1>
              <p className="mb-6 text-sm text-muted-foreground">
                برنامه با مشکلی جدی مواجه شد و بارگذاری نشد. گزارش آن ثبت شد؛ لطفاً دوباره تلاش
                کنید.
              </p>
              <p className="mb-2 text-xs text-muted-foreground">
                شناسهٔ خطا (برای پشتیبانی): <span dir="ltr" className="font-mono">{errorId}</span>
              </p>
              {error.digest && (
                <p className="mb-4 text-xs text-muted-foreground">
                  کد پیگیری سرور: <span dir="ltr">{error.digest}</span>
                </p>
              )}
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={reset}
                  className="w-full rounded-lg bg-primary py-2.5 font-semibold text-primary-foreground transition hover:bg-primary/85 outline-none focus-visible:ring focus-visible:ring-ring/50"
                >
                  تلاش دوباره
                </button>
                <button
                  type="button"
                  onClick={downloadLogs}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-input py-2.5 text-sm font-semibold transition hover:bg-primary/10 outline-none focus-visible:ring focus-visible:ring-ring/50"
                >
                  <DownloadIcon aria-hidden="true" className="size-4" />
                  دریافت فایل گزارش‌ها
                </button>
                <Link
                  href="/"
                  className="w-full rounded-lg border border-input py-2.5 text-center text-sm font-semibold transition hover:bg-primary/10 outline-none focus-visible:ring focus-visible:ring-ring/50"
                >
                  بازگشت به صفحهٔ اصلی
                </Link>
              </div>
            </div>
          </main>
        </ThemeProvider>
      </body>
    </html>
  );
}
