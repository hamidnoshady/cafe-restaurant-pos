import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { GrowthSection } from "../growth-section";
import { canViewGrowthSection, growthFallbackHref } from "../growth-routes";

/** Growth → Seller Commission. Owner/manager only (compensation data). */
export default async function GrowthCommissionPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!canViewGrowthSection(session.role, "commission")) redirect(growthFallbackHref(session.role));

  return <GrowthSection section="commission" role={session.role} />;
}
