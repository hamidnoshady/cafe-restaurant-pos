import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { GrowthSection } from "../growth-section";
import { canViewGrowthSection, growthFallbackHref } from "../growth-routes";

/** Growth → Campaigns. Owner/manager only. */
export default async function GrowthCampaignsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!canViewGrowthSection(session.role, "campaigns")) redirect(growthFallbackHref(session.role));

  return <GrowthSection section="campaigns" role={session.role} />;
}
