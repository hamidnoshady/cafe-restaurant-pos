import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { CrmSection } from "../crm-section";
import { canViewCrmSection, crmFallbackHref } from "../crm-routes";

/** CRM → بخش‌بندی. Segment builder. Management: a segment defines who gets messaged. */
export default async function CrmSegmentsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  const permissions: ReadonlySet<string> = access?.permissions ?? new Set<string>();
  if (!canViewCrmSection(permissions, "segments")) redirect(crmFallbackHref(permissions));

  return <CrmSection section="segments" role={session.role} />;
}
