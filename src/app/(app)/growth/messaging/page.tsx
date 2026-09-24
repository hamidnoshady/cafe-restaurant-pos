import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { GrowthSection } from "../growth-section";
import { canViewGrowthSection, growthFallbackHref } from "../growth-routes";

/** Growth → consent-aware outbound SMS and email campaigns. */
export default async function GrowthMessagingPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!canViewGrowthSection(session.role, "messaging")) redirect(growthFallbackHref(session.role));

  return <GrowthSection section="messaging" role={session.role} />;
}
