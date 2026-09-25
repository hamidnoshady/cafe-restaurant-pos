import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS } from "@/lib/permissions";
import { requireFeatureForPage } from "@/lib/features";
import { requireModuleForPage } from "@/lib/industry-guard";
import { FloorPlan } from "@/app/dashboard/floor/floor-plan";

export default async function FloorPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  await requireModuleForPage(session.businessId, "tables");
  await requireFeatureForPage(session.businessId, "reservations");

  const access = await memberAccessFor(session);
  const permissions = access?.permissions ?? new Set<string>();
  if (!permissions.has(PERMISSIONS.tablesManage)) redirect("/dashboard");

  // Seating a party is `tables.manage`; redrawing the floor plan itself is a
  // configuration change, so it is `settings.manage`.
  return <FloorPlan canEdit={permissions.has(PERMISSIONS.settingsManage)} />;
}
