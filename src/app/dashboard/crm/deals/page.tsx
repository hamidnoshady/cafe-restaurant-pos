import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { CrmSection } from "../crm-section";
import { canViewCrmSection, crmFallbackHref } from "../crm-routes";

/** CRM → قیف فروش. The sales pipeline. Management: revenue expectations. */
export default async function CrmDealsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!canViewCrmSection(session.role, "deals")) redirect(crmFallbackHref(session.role));

  return <CrmSection section="deals" role={session.role} />;
}
