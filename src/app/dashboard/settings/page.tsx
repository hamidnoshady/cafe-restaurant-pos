import { redirect } from "next/navigation";
import { getSession, type Role } from "@/lib/auth";
import { query, withTenant } from "@/lib/db";
import { effectivePermissions, parseOverrides } from "@/lib/permissions";
import { visibleSettingsTabs } from "@/lib/settings-tabs";
import { SettingsManager } from "./settings-manager";

export default async function SettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  // See the matching comment in dashboard/layout.tsx: this needs an explicit
  // withTenant() scope, not the ambient one getSession() set via enterWith(),
  // since that doesn't survive a concurrent run() elsewhere in the process.
  const { rows } = await withTenant(
    session.businessId,
    () =>
      query<{ role: Role; permissions: unknown; is_active: boolean }>(
        "SELECT role, permissions, is_active FROM users WHERE id = $1 AND business_id = $2",
        [session.sub, session.businessId],
      ),
    { locationId: session.locationId, userId: session.sub },
  );
  const member = rows[0];
  if (!member?.is_active) redirect("/dashboard");

  const tabs = visibleSettingsTabs(effectivePermissions(member.role, parseOverrides(member.permissions)));
  if (tabs.length === 0) redirect("/dashboard");

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">تنظیمات</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          مدیریت اطلاعات کسب‌وکار، امور مالی، دسترسی‌ها، منو و تجهیزات. بخش‌هایی که مجوزشان را ندارید نمایش داده نمی‌شوند.
        </p>
      </header>
      <SettingsManager tabs={tabs} currentUserId={session.sub} />
    </div>
  );
}
