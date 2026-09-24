import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { GrowthSection } from "../growth-section";
import { canViewGrowthSection, growthFallbackHref } from "../growth-routes";

/** Growth → Seller Commission. Owner/manager only (compensation data). */
export default async function GrowthCommissionPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  // The member's live effective permissions — the same set the API enforces,
  // so the page and the fetches inside it can never disagree about access.
  const access = await memberAccessFor(session);
  const permissions: ReadonlySet<string> = access?.permissions ?? new Set<string>();
  if (!canViewGrowthSection(permissions, "commission")) redirect(growthFallbackHref(permissions));

  return <GrowthSection section="commission" role={session.role} />;
}
