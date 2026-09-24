import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { GrowthSection } from "../growth-section";
import { canViewGrowthSection, growthFallbackHref } from "../growth-routes";

/**
 * `/growth/overview` — the Growth & Marketing app's home (میز کار رشد).
 *
 * A real route, so it is never a rewrite of an older path and never redirects
 * onward to `/growth/overview/overview`.
 *
 * Owner/manager only: the dashboard aggregates commission (compensation) data,
 * the same reason the ledger's payroll tab is not for a manager. A cashier or
 * an accountant who lands here from a bookmark is sent to the first surface
 * they may open, inside the app rather than out of it.
 */
export default async function GrowthOverviewPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  // The member's live effective permissions — the same set the API enforces,
  // so the page and the fetches inside it can never disagree about access.
  const access = await memberAccessFor(session);
  const permissions: ReadonlySet<string> = access?.permissions ?? new Set<string>();
  if (!canViewGrowthSection(permissions, "overview")) redirect(growthFallbackHref(permissions));

  return <GrowthSection section="overview" role={session.role} />;
}
