import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { GrowthSection } from "../growth-section";
import { growthSectionHref } from "../growth-routes";

/**
 * `/growth/overview` — the Growth & Marketing app's home (میز کار رشد).
 *
 * A real route, so it is never a rewrite of `/dashboard/growth` and never
 * redirects onward to `/growth/overview/overview`.
 *
 * Owner/manager only: the dashboard aggregates commission (compensation) data,
 * the same reason the ledger's payroll tab is not for a manager. A cashier who
 * lands here from a bookmark is sent to the one surface they may open, inside
 * the app rather than out of it.
 */
export default async function GrowthOverviewPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role === "cashier") redirect(growthSectionHref("loyalty"));
  if (session.role === "accountant") redirect(growthSectionHref("customers"));
  if (!["owner", "manager"].includes(session.role)) redirect("/dashboard");

  return <GrowthSection section="overview" role={session.role} />;
}
