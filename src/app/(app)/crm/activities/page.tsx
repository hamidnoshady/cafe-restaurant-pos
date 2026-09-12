import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { CrmSection } from "../crm-section";
import { canViewCrmSection, crmFallbackHref } from "../crm-routes";

/** CRM → کارها و پیگیری‌ها. Activities and tasks. Floor work. */
export default async function CrmActivitiesPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!canViewCrmSection(session.role, "activities")) redirect(crmFallbackHref(session.role));

  return <CrmSection section="activities" role={session.role} />;
}
