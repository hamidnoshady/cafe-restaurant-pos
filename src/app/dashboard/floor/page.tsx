import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireModuleForPage } from "@/lib/industry-guard";
import { requireFeatureForPage } from "@/lib/features";
import { FloorPlan } from "./floor-plan";

export default async function FloorPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  await requireModuleForPage(session.businessId, "tables");
  await requireFeatureForPage(session.businessId, "reservations");

  const canEdit = session.role === "owner" || session.role === "manager";

  return <FloorPlan canEdit={canEdit} />;
}
