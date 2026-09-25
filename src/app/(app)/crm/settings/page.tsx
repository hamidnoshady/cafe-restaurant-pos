import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { CrmSection } from "../crm-section";
import { canViewCrmSection, crmFallbackHref } from "../crm-routes";

/**
 * `/crm/settings` — the CRM app's own settings.
 *
 * Its own route and its own component: never the platform settings page, and
 * never a redirect to `/settings`, which configures the business rather than
 * this app.
 */
export default async function CrmSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  const permissions: ReadonlySet<string> = access?.permissions ?? new Set<string>();
  if (!canViewCrmSection(permissions, "settings")) redirect(crmFallbackHref(permissions));

  return <CrmSection section="settings" role={session.role} />;
}
