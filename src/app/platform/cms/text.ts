/**
 * Persian for the CMS section's error codes and statuses.
 *
 * Kept out of the pages for the reason the console's own `errorMessage` exists: a
 * code shown to an operator («cms_forbidden», «۴۰۳») is not an instruction, and the
 * same code must read the same on every screen of the section. This module is the
 * one place a new code gets its sentence.
 */

const ERRORS: Record<string, string> = {
  bad_request: "درخواست نامعتبر بود.",
  cms_failed: "درخواست به سایت‌ساز ناموفق بود.",
  cms_forbidden: "کلید پلتفرم پذیرفته نشد؛ آن را در بخش «اتصال» بازبینی کنید.",
  cms_not_configured: "نشانی یا کلید سایت‌ساز تنظیم نشده است.",
  cms_not_found: "سایت‌ساز این نشانی را نمی‌شناسد؛ نشانی پایه را بازبینی کنید.",
  cms_unreachable: "سایت‌ساز پاسخ نداد.",
  credentials_in_url: "نشانی نباید نام کاربری یا رمز داشته باشد.",
  forbidden: "این عملیات در سطح دسترسی شما نیست.",
  https_required: "نشانی باید https باشد؛ برای شبکهٔ داخلی گزینهٔ «اتصال بدون TLS» را فعال کنید.",
  invalid_api_key: "کلید پلتفرم معتبر نیست.",
  invalid_domain: "دامنه معتبر نیست.",
  invalid_interval: "بازهٔ آینه‌برداری باید بین ۵ دقیقه و ۲۴ ساعت باشد.",
  invalid_kind: "نوع همگام‌سازی نامعتبر است.",
  invalid_locales: "فهرست زبان‌ها نامعتبر است.",
  invalid_name: "نام باید بین ۱ تا ۱۲۰ نویسه باشد.",
  invalid_status: "وضعیت نامعتبر است.",
  invalid_type: "نوع سایت نامعتبر است.",
  invalid_url: "نشانی معتبر نیست.",
  label_too_long: "برچسب بیش از حد بلند است.",
  nothing_to_change: "تغییری برای ذخیره وجود ندارد.",
  site_mismatch:
    "این تصویر از سایت دیگری گرفته شده است؛ ارجاع‌هایش به رسانه و دسته‌بندی آن سایت اشاره می‌کنند.",
  site_required: "ابتدا یک سایت انتخاب کنید.",
  snapshot_required: "تصویر محتوا ارسال نشده است.",
  too_long: "نشانی بیش از حد بلند است.",
  unauthorized: "وارد نشده‌اید.",
};

export function cmsErrorText(code: null | string | undefined): string {
  if (!code) return "خطای نامشخص.";
  if (ERRORS[code]) return ERRORS[code];
  // `cms_error_502` and friends are generated from the CMS's own status, so they
  // cannot all be in the table — say the useful half rather than "unknown".
  const status = /^cms_error_(\d{3})$/.exec(code);
  if (status) return `سایت‌ساز با کد ${status[1]} پاسخ داد.`;
  return code;
}

/** The Persian a verification result reads as, on the connection page. */
export function cmsVerifyText(reason: null | string | undefined, ok: boolean): string {
  if (ok) return "اتصال برقرار است و کلید پذیرفته شد.";
  switch (reason) {
    case "forbidden":
      return "نشانی درست است اما کلید پلتفرم پذیرفته نشد.";
    case "not_found":
      return "این نشانی مسیر /api/platform را نمی‌شناسد؛ ممکن است نسخهٔ سایت‌ساز قدیمی باشد.";
    case "unreachable":
      return "سایت‌ساز از این سرور در دسترس نیست.";
    default:
      return "سایت‌ساز با خطا پاسخ داد.";
  }
}

export function syncStatusTone(status: "failed" | "ok" | "partial"): string {
  switch (status) {
    case "failed":
      return "text-red-300";
    case "partial":
      return "text-amber-300";
    default:
      return "text-emerald-300";
  }
}

export const SYNC_STATUS_LABELS: Record<"failed" | "ok" | "partial", string> = {
  failed: "ناموفق",
  ok: "موفق",
  partial: "ناقص",
};

export const SITE_STATUS_LABELS: Record<string, string> = {
  active: "فعال",
  archived: "بایگانی‌شده",
  suspended: "معلق",
};

export const SITE_TYPE_LABELS: Record<string, string> = {
  business: "کسب‌وکار",
  portfolio: "نمونه‌کار",
  store: "فروشگاه",
};

/** The collections a snapshot may carry, with the Persian the UI lists them by. */
export const SNAPSHOT_COLLECTION_LABELS: Record<string, string> = {
  categories: "دسته‌بندی‌ها",
  footer: "پابرگ",
  header: "سربرگ",
  pages: "صفحه‌ها",
  posts: "نوشته‌ها",
  products: "محصولات",
  store: "تنظیمات فروشگاه",
  theme: "پوسته",
};
