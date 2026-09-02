"use client";

import { useEffect } from "react";
import Link from "next/link";
import { CircleAlertIcon } from "lucide-react";
import { cardClass } from "@/app/dashboard/page-chrome";

/**
 * Catches a render error anywhere below the root layout (fonts, theme and
 * providers are already mounted, so this can stay a plain page). The digest
 * is Next's own opaque reference id for the server-side log entry — never
 * `error.message`/`error.stack`, which can carry a raw driver message or a
 * file path (see the error-handling audit: the API layer already keeps that
 * split, this keeps it for render errors too).
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className={`w-full max-w-sm ${cardClass} p-8 text-center`}>
        <CircleAlertIcon className="mx-auto mb-4 size-10 text-destructive" />
        <h1 className="mb-1 text-xl font-bold">خطایی پیش آمد</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          مشکلی در نمایش این صفحه رخ داد. گزارش آن ثبت شد؛ می‌توانید دوباره تلاش کنید یا به صفحهٔ
          اصلی بازگردید.
        </p>
        {error.digest && (
          <p className="mb-6 text-xs text-muted-foreground">
            کد پیگیری: <span dir="ltr">{error.digest}</span>
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
