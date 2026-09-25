import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { CrmSection } from "../crm-section";
import { canViewCrmSection, crmFallbackHref } from "../crm-routes";

/** CRM → قیف فروش. The sales pipeline. Management: revenue expectations. */
export default async function CrmDealsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  const permissions: ReadonlySet<string> = access?.permissions ?? new Set<string>();
  if (!canViewCrmSection(permissions, "deals")) redirect(crmFallbackHref(permissions));

  return <CrmSection section="deals" role={session.role} />;
}
