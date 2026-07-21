"use client";

import { toPersianDigits } from "@/lib/digits";
import { useOfflineQueue } from "./offline-queue";

/** Persistent status strip shown on every dashboard page while offline or while queued actions await sync. */
export function OfflineBanner() {
  const { pendingCount, isOnline } = useOfflineQueue();
  if (isOnline && pendingCount === 0) return null;

  return (
    <div
      className={`px-4 py-2 text-center text-sm font-medium ${
        isOnline ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive"
      }`}
    >
      {!isOnline ? "اتصال به سرور قطع است — عملیات‌ها ذخیره می‌شوند و پس از اتصال مجدد ارسال خواهند شد." : "در حال همگام‌سازی…"}
      {pendingCount > 0 ? ` (${toPersianDigits(pendingCount)} مورد در صف)` : ""}
    </div>
  );
}
