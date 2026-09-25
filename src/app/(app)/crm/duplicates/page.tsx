import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { CrmSection } from "../crm-section";
import { canViewCrmSection, crmFallbackHref } from "../crm-routes";

/** CRM → مشتریان تکراری. Duplicate detection and merge. Management: merge is irreversible. */
export default async function CrmDuplicatesPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  const permissions: ReadonlySet<string> = access?.permissions ?? new Set<string>();
  if (!canViewCrmSection(permissions, "duplicates")) redirect(crmFallbackHref(permissions));

  return <CrmSection section="duplicates" role={session.role} />;
}
