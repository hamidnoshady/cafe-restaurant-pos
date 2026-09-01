"use client";

/**
 * «برنامه‌ها» — the deployment-wide app switchboard.
 *
 * The console could already turn a *capability* off per business (feature
 * flags), but had no way to say "the CRM is coming soon" or "accounting is
 * down for an hour" across the whole platform, which is the thing an operator
 * actually needs during a release or an incident. This page is that: one row
 * per app in the registry (src/lib/apps.ts), each with a state, an optional
 * message the business sees verbatim, and an optional Shamsi return date.
 *
 * A per-business exception lives where every other per-business setting does —
 * inside the business, on its «قابلیت‌ها و اتصال» tab.
 */
import { AppAvailabilityEditor } from "../app-availability-editor";

export default function PlatformAppsPage() {
  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">برنامه‌ها</h1>
        <p className="mt-1 text-sm text-white/50">
          وضعیت هر برنامه در کل سکو: فعال، به‌زودی، در حال تعمیر، نسخهٔ آزمایشی یا غیرفعال. برنامه‌ای که
          فعال نباشد از دید کاربر پنهان نمی‌شود؛ با همین برچسب نمایش داده می‌شود و به‌جای صفحهٔ برنامه،
          توضیح شما را می‌بیند.
        </p>
      </header>
      <AppAvailabilityEditor
        scope="platform"
        endpoint="/api/platform/app-availability"
        title="وضعیت برنامه‌ها در سکو"
        description="این وضعیت پیش‌فرض همهٔ کسب‌وکارهاست. برای یک کسب‌وکار خاص، از تب «قابلیت‌ها و اتصال» همان کسب‌وکار استثنا تعریف کنید."
      />
    </div>
  );
}
