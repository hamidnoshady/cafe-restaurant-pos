import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { GrowthSection } from "../growth-section";
import { canViewGrowthSection, growthFallbackHref } from "../growth-routes";

/** Growth → Loyalty & Store Credit. Open to owner, manager and cashier. */
export default async function GrowthLoyaltyPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  const permissions = access?.permissions ?? new Set();
  if (!canViewGrowthSection(permissions, "loyalty")) redirect(growthFallbackHref(permissions));

  return <GrowthSection section="loyalty" permissions={[...permissions]} />;
}
