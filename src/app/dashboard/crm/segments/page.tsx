import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { CrmSection } from "../crm-section";
import { canViewCrmSection, crmFallbackHref } from "../crm-routes";

/** CRM → بخش‌بندی. Segment builder. Management: a segment defines who gets messaged. */
export default async function CrmSegmentsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!canViewCrmSection(session.role, "segments")) redirect(crmFallbackHref(session.role));

  return <CrmSection section="segments" role={session.role} />;
}
