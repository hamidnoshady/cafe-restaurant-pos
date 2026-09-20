import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
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
  if (!canViewCrmSection(session.role, "reconciliation")) redirect(crmFallbackHref(session.role));

  return <CrmSection section="reconciliation" role={session.role} />;
}
