import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { CrmSection } from "./crm-section";
import { canViewCrmSection, crmFallbackHref } from "./crm-routes";

/**
 * The CRM app — overview (میز کار ارتباط با مشتری).
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
