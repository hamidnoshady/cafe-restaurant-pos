"use client";

/**
 * First screen of the desktop first-run wizard: local-only, or claim an
 * existing online business.
 *
 * Two cards rather than a dropdown, because this is a decision the owner makes
 * once and cannot change afterwards — it deserves the space to say what each
 * option costs.
 */
export function ModeChoice({ onChoose }: { onChoose: (mode: "local" | "connect") => void }) {
  return (
    <div className="w-full max-w-3xl">
      <h1 className="mb-1 text-2xl font-bold">به سیستم فروش خوش آمدید</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        این نصب را چگونه راه‌اندازی می‌کنید؟
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => onChoose("local")}
          className="rounded-2xl border border-input bg-card p-6 text-start shadow-sm transition hover:border-primary hover:shadow-md"
        >
          <p className="mb-2 text-lg font-bold">راه‌اندازی محلی</p>
          <p className="mb-4 text-sm text-muted-foreground">
            کسب‌وکار جدیدی روی همین دستگاه بسازید. همه‌چیز محلی می‌ماند و به اینترنت نیازی نیست.
          </p>
          <ul className="space-y-1 text-xs text-muted-foreground">
            <li>• فروش، منو، انبار، حسابداری و گزارش‌ها فعال</li>
            <li>• پشتیبان‌گیری روی درایو محلی</li>
            <li>• دستیار هوش مصنوعی و همگام‌سازی چندشعبه‌ای غیرفعال</li>
          </ul>
        </button>

        <button
          type="button"
          onClick={() => onChoose("connect")}
          className="rounded-2xl border border-input bg-card p-6 text-start shadow-sm transition hover:border-primary hover:shadow-md"
        >
          <p className="mb-2 text-lg font-bold">اتصال به پلتفرم آنلاین</p>
          <p className="mb-4 text-sm text-muted-foreground">
            اگر کسب‌وکار شما از قبل روی پلتفرم آنلاین ساخته شده است، آدرس پنل ابری و یک کد اتصال
            بگیرید تا همان تنظیمات روی این دستگاه بیاید.
          </p>
          <ul className="space-y-1 text-xs text-muted-foreground">
            <li>• منو، کاربران، حساب‌ها و تنظیمات از سرور می‌آید</li>
            <li>• کارکنان با همان پین همیشگی وارد می‌شوند</li>
            <li>• کد اتصال را خودتان در پنل ابری می‌سازید</li>
          </ul>
        </button>
      </div>
    </div>
  );
}
