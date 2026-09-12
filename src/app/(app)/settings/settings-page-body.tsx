import { redirect } from "next/navigation";
import { getSession, type Role } from "@/lib/auth";
import { query, withTenant } from "@/lib/db";
import { effectiveFeatures } from "@/lib/features";
import type { Industry } from "@/lib/industries";
import { labelFor } from "@/lib/industry-profile";
import { effectivePermissions, parseOverrides } from "@/lib/permissions";
import { visibleSettingsTabs, type SettingsTabKey } from "@/lib/settings-tabs";
import { settingsTabHref } from "@/lib/settings-routes";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { SettingsManager } from "./settings-manager";

/**
 * What every platform settings URL renders.
 *
 * The area is many routes now — `/settings`, `/settings/team`,
 * `/settings/printers` — and all of them need the same four reads (the
 * member's row, the business's features, its industry, the resulting visible
 * tabs) before they can decide what the member may see. Keeping that in one
 * body rather than in each page means a new section cannot come with a
 * slightly different gate.
 *
 * The gate itself is unchanged and deliberately strict: a section the member's
 * permissions do not include is not rendered read-only, it redirects — to the
 * first section they *can* open, or out of settings entirely when there is
 * none. A URL nobody may open must never become a 404 either, which is why the
 * unknown-section case lands on the settings home rather than falling through.
 *
 * This is the *platform's* settings. Each app's settings are the app's own
 * pages (`/accounting/settings` and friends); nothing here is ever rendered
 * inside an app, and no app links to a `?tab=` of this page in place of having
 * settings of its own.
 */
export async function SettingsPageBody({ section }: { section?: SettingsTabKey | null }) {
  const session = await getSession();
  if (!session) redirect("/login");

  // See the matching comment in dashboard/workspace-shell.tsx: this needs an
  // explicit withTenant() scope, not the ambient one getSession() set via
  // enterWith(), since that doesn't survive a concurrent run() elsewhere in the
  // process. Keep every database-backed visibility check in this same scope.
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

  // A section this member may not open sends them to one they may, rather than
  // showing an empty frame or a 404.
  if (section && !tabs.some((tab) => tab.key === section)) {
    redirect(settingsTabHref(tabs[0]!.key));
  }

  const activeTab = tabs.find((tab) => tab.key === section) ?? null;

  return (
    <PageShell className="max-w-[1500px]">
      <PageHeader
        title={activeTab ? `تنظیمات — ${activeTab.label}` : "تنظیمات"}
        description={
          activeTab ? (
            activeTab.description
          ) : (
            <>
              مدیریت اطلاعات کسب‌وکار، امور مالی، دسترسی‌ها، {labelFor(industry, "catalogue")} و تجهیزات.
              <span className="hidden sm:inline"> بخش‌هایی که مجوزشان را ندارید نمایش داده نمی‌شوند.</span>
            </>
          )
        }
        actions={<KnowledgeHelpButton section="settings" />}
      />
      <SettingsManager
        tabs={tabs}
        activeTab={section ?? null}
        features={features}
        currentUserId={session.sub}
        isOwner={member.role === "owner"}
        role={session.role}
      />
    </PageShell>
  );
}
