import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { GrowthSection } from "../growth-section";
import { canViewGrowthSection, growthFallbackHref } from "../growth-routes";

/** Growth → Gift Cards. Owner/manager only. */
export default async function GrowthGiftCardsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  const permissions = access?.permissions ?? new Set();
  if (!canViewGrowthSection(permissions, "gift-cards")) redirect(growthFallbackHref(permissions));

  return <GrowthSection section="gift-cards" permissions={[...permissions]} />;
}
