import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { CrmSection } from "../crm-section";
import { canViewCrmSection, crmFallbackHref } from "../crm-routes";

/**
 * CRM → تطبیق فروشگاه آنلاین. The queue of online shoppers the sync could not
 * confidently identify. Management: linking a shopper to a customer attaches
 * their purchase history to a named person.
 */
export default async function CrmReconciliationPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  const permissions = access?.permissions ?? new Set();
  if (!canViewCrmSection(permissions, "reconciliation")) redirect(crmFallbackHref(permissions));

  return <CrmSection section="reconciliation" role={access?.role ?? session.role} permissions={[...permissions]} />;
}
