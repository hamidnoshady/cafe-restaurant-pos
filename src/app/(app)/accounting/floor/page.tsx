import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireFeatureForPage } from "@/lib/features";
import { requireModuleForPage } from "@/lib/industry-guard";
import { FloorPlan } from "@/app/dashboard/floor/floor-plan";

export default async function FloorPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  await requireModuleForPage(session.businessId, "tables");
  await requireFeatureForPage(session.businessId, "reservations");

  return <FloorPlan canEdit={session.role === "owner" || session.role === "manager"} />;
}
