import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { CrmSection } from "../crm-section";
import { canViewCrmSection, crmFallbackHref } from "../crm-routes";

/** CRM → مشتریان. The customer directory — search, add, edit. Floor work. */
export default async function CrmDirectoryPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!canViewCrmSection(session.role, "directory")) redirect(crmFallbackHref(session.role));

  return <CrmSection section="directory" role={session.role} />;
}
