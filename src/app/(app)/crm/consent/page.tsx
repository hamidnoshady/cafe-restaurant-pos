import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { CrmSection } from "../crm-section";
import { canViewCrmSection, crmFallbackHref } from "../crm-routes";

/** CRM → رضایت ارتباط. The consent register. Management: the audit trail for every send. */
export default async function CrmConsentPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  const permissions = access?.permissions ?? new Set();
  if (!canViewCrmSection(permissions, "consent")) redirect(crmFallbackHref(permissions));

  return <CrmSection section="consent" role={access?.role ?? session.role} permissions={[...permissions]} />;
}
