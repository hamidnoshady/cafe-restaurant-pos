import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { CrmSection } from "../crm-section";
import { canViewCrmSection, crmFallbackHref } from "../crm-routes";

/** CRM → تیکت‌های خدمات. The service desk. Floor work — the counter hears the complaint. */
export default async function CrmCasesPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!canViewCrmSection(session.role, "cases")) redirect(crmFallbackHref(session.role));

  return <CrmSection section="cases" role={session.role} />;
}
