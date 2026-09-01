"use client";

/**
 * The per-business half of the app switchboard.
 *
 * Thin on purpose: the control itself is `AppAvailabilityEditor` (shared with
 * /platform/apps), and this only binds it to the business the workspace has
 * open and re-reads it when any other panel writes (`version`, see context.tsx).
 * An operator who changes nothing here leaves the business following the
 * platform-wide state.
 */
import { AppAvailabilityEditor } from "../../app-availability-editor";
import { useBusiness } from "./context";

export function BusinessAppAvailabilityPanel() {
  const { business, version } = useBusiness();
  if (!business) return null;
  return (
    <AppAvailabilityEditor
      scope="business"
      endpoint={`/api/platform/businesses/${business.id}/app-availability`}
      title="وضعیت برنامه‌ها برای این کسب‌وکار"
      description="به‌طور پیش‌فرض هر برنامه از وضعیت سکو پیروی می‌کند. اینجا می‌توانید فقط برای این کسب‌وکار استثنا بگذارید — مثلاً یک برنامه را برای آن‌ها «نسخهٔ آزمایشی» یا «در حال تعمیر» کنید."
      refreshKey={version}
    />
  );
}
