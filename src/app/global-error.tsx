"use client";

import { useEffect } from "react";
import localFont from "next/font/local";
import Link from "next/link";
import { CircleAlertIcon } from "lucide-react";
import { ThemeProvider } from "@/components/theme-provider";
import { cardClass } from "@/app/dashboard/page-chrome";
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
 * way to fail. Same rule as `error.tsx`: never render `error.message` or
 * `.stack`, only the opaque `digest`.
 */
export default function GlobalError({
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
        </ThemeProvider>
      </body>
    </html>
  );
}
