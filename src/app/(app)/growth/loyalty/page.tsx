import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { GrowthSection } from "../growth-section";
import { canViewGrowthSection, growthFallbackHref } from "../growth-routes";

/** Growth → Loyalty & Store Credit. Open to owner, manager and cashier. */
export default async function GrowthLoyaltyPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  // The member's live effective permissions — the same set the API enforces,
  // so the page and the fetches inside it can never disagree about access.
  const access = await memberAccessFor(session);
  const permissions: ReadonlySet<string> = access?.permissions ?? new Set<string>();
  if (!canViewGrowthSection(permissions, "loyalty")) redirect(growthFallbackHref(permissions));

  return <GrowthSection section="loyalty" role={session.role} />;
}
