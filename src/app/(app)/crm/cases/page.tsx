import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { CrmSection } from "../crm-section";
import { canViewCrmSection, crmFallbackHref } from "../crm-routes";

/** CRM → تیکت‌های خدمات. The service desk. Floor work — the counter hears the complaint. */
export default async function CrmCasesPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  const permissions = access?.permissions ?? new Set();
  if (!canViewCrmSection(permissions, "cases")) redirect(crmFallbackHref(permissions));

  return <CrmSection section="cases" role={access?.role ?? session.role} permissions={[...permissions]} />;
}
