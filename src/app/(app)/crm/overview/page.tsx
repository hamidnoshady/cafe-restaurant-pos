import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { CrmSection } from "../crm-section";
import { canViewCrmSection, crmFallbackHref } from "../crm-routes";

/**
 * `/crm/overview` — the CRM app's home (میز کار ارتباط با مشتری).
 *
 * A real route, never a rewrite of `/dashboard/crm`, and it does not redirect
 * onward: `/crm/overview` → `/crm/overview/overview` is precisely the loop the
 * old rewrite table could produce.
 *
 * Owner/manager only: the dashboard aggregates the whole customer base's spend,
 * the pipeline's expected value and consent coverage. A cashier who lands here
 * from a bookmark is sent to the directory rather than out of the app.
 */
export default async function CrmOverviewPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!canViewCrmSection(session.role, "overview")) redirect(crmFallbackHref(session.role));

  return <CrmSection section="overview" role={session.role} />;
}
