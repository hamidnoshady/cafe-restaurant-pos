import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
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
  if (!canViewCrmSection(session.role, "settings")) redirect(crmFallbackHref(session.role));

  return <CrmSection section="settings" role={session.role} />;
}
