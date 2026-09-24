import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { GrowthSection } from "../growth-section";
import { canViewGrowthSection, growthFallbackHref } from "../growth-routes";

/** Growth → Gift Cards. Owner/manager only. */
export default async function GrowthGiftCardsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!canViewGrowthSection(session.role, "gift-cards")) redirect(growthFallbackHref(session.role));

  return <GrowthSection section="gift-cards" role={session.role} />;
}
