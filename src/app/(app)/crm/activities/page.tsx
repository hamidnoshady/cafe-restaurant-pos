import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { CrmSection } from "../crm-section";
import { canViewCrmSection, crmFallbackHref } from "../crm-routes";

/** CRM → کارها و پیگیری‌ها. Activities and tasks. Floor work. */
export default async function CrmActivitiesPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  const permissions: ReadonlySet<string> = access?.permissions ?? new Set<string>();
  if (!canViewCrmSection(permissions, "activities")) redirect(crmFallbackHref(permissions));

  return <CrmSection section="activities" role={session.role} />;
}
