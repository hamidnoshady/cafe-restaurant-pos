import { redirect } from "next/navigation";
import { getSession, type Role } from "@/lib/auth";
import { query, withTenant } from "@/lib/db";
import { effectiveFeatures } from "@/lib/features";
import type { Industry } from "@/lib/industries";
import { labelFor } from "@/lib/industry-profile";
import { effectivePermissions, parseOverrides } from "@/lib/permissions";
import { visibleSettingsTabs } from "@/lib/settings-tabs";
import { PageHeader, PageShell } from "../page-chrome";
import { SettingsManager } from "./settings-manager";

export default async function SettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  // See the matching comment in dashboard/layout.tsx: this needs an explicit
  // withTenant() scope, not the ambient one getSession() set via enterWith(),
  // since that doesn't survive a concurrent run() elsewhere in the process.
  // Keep every database-backed visibility check in this same scope.
  const [{ rows }, features, { rows: bizRows }] = await withTenant(
    session.businessId,
    () =>
      Promise.all([
        query<{ role: Role; permissions: unknown; is_active: boolean }>(
          "SELECT role, permissions, is_active FROM users WHERE id = $1 AND business_id = $2",
          [session.sub, session.businessId],
        ),
        effectiveFeatures(session.businessId),
        query<{ industry: Industry }>("SELECT industry FROM businesses WHERE id = $1", [session.businessId]),
      ]),
    { locationId: session.locationId, userId: session.sub },
  );
  const member = rows[0];
  if (!member?.is_active) redirect("/dashboard");
  const industry = bizRows[0]?.industry ?? "food_service";

  const tabs = visibleSettingsTabs(
    effectivePermissions(member.role, parseOverrides(member.permissions)),
    { role: member.role, features, industry },
  );
  if (tabs.length === 0) redirect("/dashboard");

  return (
    <PageShell>
      <PageHeader
        title="تنظیمات"
        description={`مدیریت اطلاعات کسب‌وکار، امور مالی، دسترسی‌ها، ${labelFor(industry, "catalogue")} و تجهیزات. بخش‌هایی که مجوزشان را ندارید نمایش داده نمی‌شوند.`}
      />
      <SettingsManager tabs={tabs} features={features} currentUserId={session.sub} isOwner={member.role === "owner"} />
    </PageShell>
  );
}
