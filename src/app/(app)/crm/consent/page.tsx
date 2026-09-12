import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { CrmSection } from "../crm-section";
import { canViewCrmSection, crmFallbackHref } from "../crm-routes";

/** CRM → رضایت ارتباط. The consent register. Management: the audit trail for every send. */
export default async function CrmConsentPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!canViewCrmSection(session.role, "consent")) redirect(crmFallbackHref(session.role));

  return <CrmSection section="consent" role={session.role} />;
}
