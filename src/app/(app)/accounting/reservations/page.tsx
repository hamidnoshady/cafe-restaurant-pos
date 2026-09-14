import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireFeatureForPage } from "@/lib/features";
import { requireModuleForPage } from "@/lib/industry-guard";
import { ReservationsManager } from "@/app/dashboard/reservations/reservations-manager";

export default async function ReservationsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  await requireModuleForPage(session.businessId, "reservations");
  await requireFeatureForPage(session.businessId, "reservations");

  return <ReservationsManager canBook={["owner", "manager", "cashier"].includes(session.role)} />;
}
