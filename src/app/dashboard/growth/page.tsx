import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { GrowthSection } from "./growth-section";

/**
 * The Growth & Marketing app — overview (میز کار رشد).
 *
 * Owner/manager only: the dashboard aggregates commission (compensation) data,
 * the same reason the ledger's payroll tab is not for a manager. A cashier who
 * lands here (a saved bookmark, say) is sent to the one surface they may open.
 */
export default async function GrowthOverviewPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role === "cashier") redirect("/dashboard/growth/loyalty");
  if (session.role === "accountant") redirect("/dashboard/growth/customers");
  if (!["owner", "manager"].includes(session.role)) redirect("/dashboard");

  return <GrowthSection section="overview" />;
}
