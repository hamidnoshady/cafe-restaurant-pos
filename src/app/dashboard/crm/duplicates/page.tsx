import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { CrmSection } from "../crm-section";
import { canViewCrmSection, crmFallbackHref } from "../crm-routes";

/** CRM → مشتریان تکراری. Duplicate detection and merge. Management: merge is irreversible. */
export default async function CrmDuplicatesPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!canViewCrmSection(session.role, "duplicates")) redirect(crmFallbackHref(session.role));

  return <CrmSection section="duplicates" role={session.role} />;
}
