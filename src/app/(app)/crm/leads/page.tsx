import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { CrmSection } from "../crm-section";
import { canViewCrmSection, crmFallbackHref } from "../crm-routes";

/**
 * CRM → سرنخ‌ها. Enquiries that have not become customers yet. Management:
 * converting a lead creates a customer record and can open a deal.
 */
export default async function CrmLeadsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  const permissions: ReadonlySet<string> = access?.permissions ?? new Set<string>();
  if (!canViewCrmSection(permissions, "leads")) redirect(crmFallbackHref(permissions));

  return <CrmSection section="leads" role={session.role} />;
}
