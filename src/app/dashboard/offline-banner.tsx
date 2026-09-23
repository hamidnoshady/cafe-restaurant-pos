"use client";

import { toPersianDigits } from "@/lib/digits";
import { useOfflineQueue } from "./offline-queue";

/** Distinguishes LAN/server availability from the optional outbound cloud link. */
export function OfflineBanner() {
  const { pendingCount, connectionState } = useOfflineQueue();
  const localUnavailable = connectionState.localServer === "local_server_unreachable";
  const cloudPaused = connectionState.cloudSync === "cloud_sync_paused";
  const needsAttention = connectionState.attentionNeeded > 0;
  if (!localUnavailable && !cloudPaused && !needsAttention && pendingCount === 0) return null;

  let message: string;
  let className: string;
  if (needsAttention) {
    // Highest priority: a failed/conflicted entry needs a human decision and
    // will not resolve itself just because the connection comes back — see
    // the Sync Queue panel under Settings → Devices.
    message = `${toPersianDigits(connectionState.attentionNeeded)} اقدام در صف همگام‌سازی نیازمند بررسی است (ناموفق یا در تداخل). برای بررسی به «تنظیمات ← دستگاه‌ها» بروید.`;
    className = "bg-destructive/10 text-destructive";
  } else if (localUnavailable) {
    message = "سرور محلی در دسترس نیست — فقط عملیات‌های پشتیبانی‌شده در این دستگاه ذخیره می‌شوند؛ سایر تغییرها تا بازگشت اتصال مسدودند.";
    className = "bg-destructive/10 text-destructive";
  } else if (pendingCount > 0) {
    message = "سرور محلی متصل است؛ اقدام‌های ذخیره‌شده در حال ارسال هستند.";
    className = "bg-primary/10 text-primary";
  } else {
    message = "سرور محلی و عملیات کسب‌وکار فعال است؛ همگام‌سازی ابری موقتاً متوقف شده و پس از بازگشت اینترنت خودکار ادامه می‌یابد.";
    className = "bg-amber-500/10 text-amber-800 dark:text-amber-200";
  }

  return (
    <div className={`px-4 py-2 text-center text-sm font-medium ${className}`}>
      {message}
      {pendingCount > 0 && !needsAttention ? ` (${toPersianDigits(pendingCount)} اقدام در صف محلی)` : ""}
    </div>
  );
}
