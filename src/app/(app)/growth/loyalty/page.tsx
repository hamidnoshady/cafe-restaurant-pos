import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { GrowthSection } from "../growth-section";
import { canViewGrowthSection, growthFallbackHref } from "../growth-routes";

/** Growth → Loyalty & Store Credit. Open to owner, manager and cashier. */
export default async function GrowthLoyaltyPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!canViewGrowthSection(session.role, "loyalty")) redirect(growthFallbackHref(session.role));

  return <GrowthSection section="loyalty" role={session.role} />;
}
