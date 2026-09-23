"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CircleAlertIcon, DownloadIcon } from "lucide-react";
import { cardClass } from "@/app/dashboard/page-chrome";
import { buildTechnicalReport, exportClientErrorLog, generateErrorId, recordClientError } from "@/lib/error-report";

/**
 * Catches a render error anywhere below the root layout (fonts, theme and
 * providers are already mounted, so this can stay a plain page).
 *
 * Section 12 of the desktop audit: every error gets a friendly message (the
 * Persian copy below), a short **error ID** the user can quote to support
 * (generateErrorId — distinct from Next's own `digest`, which is a
 * server-log correlation id that is not always present for a purely
 * client-side error), an on-demand **technical log** (message/stack, secrets
 * redacted — see error-report.ts's redactSecrets, the same rule the desktop's
 * own log writer uses), and an **export logs** button that downloads every
 * recently recorded client error, not just this one, as a single text file.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [showDetails, setShowDetails] = useState(false);
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
    // Only once per mounted error instance — recordClientError already de-dupes
    // nothing itself, so re-running this on every render would spam the log.
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
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className={`w-full max-w-sm ${cardClass} p-8 text-center`}>
        <CircleAlertIcon className="mx-auto mb-4 size-10 text-destructive" />
        <h1 className="mb-1 text-xl font-bold">خطایی پیش آمد</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          مشکلی در نمایش این صفحه رخ داد. گزارش آن ثبت شد؛ می‌توانید دوباره تلاش کنید یا به صفحهٔ
          اصلی بازگردید.
        </p>
        <p className="mb-2 text-xs text-muted-foreground">
          شناسهٔ خطا (برای پشتیبانی): <span dir="ltr" className="font-mono">{errorId}</span>
        </p>
        {error.digest && (
          <p className="mb-4 text-xs text-muted-foreground">
            کد پیگیری سرور: <span dir="ltr">{error.digest}</span>
          </p>
        )}
        <button
          type="button"
          onClick={() => setShowDetails((v) => !v)}
          className="mb-4 text-xs font-medium text-primary underline-offset-2 hover:underline"
        >
          {showDetails ? "پنهان‌کردن جزئیات فنی" : "نمایش جزئیات فنی"}
        </button>
        {showDetails ? (
          <pre
            dir="ltr"
            className="mb-4 max-h-40 overflow-auto rounded-lg border border-border bg-muted/40 p-3 text-start text-[11px] leading-5 text-muted-foreground"
          >
            {report}
          </pre>
        ) : null}
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
  );
}
