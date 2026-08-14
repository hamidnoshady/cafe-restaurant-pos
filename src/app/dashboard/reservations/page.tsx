import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireModuleForPage } from "@/lib/industry-guard";
import { requireFeatureForPage } from "@/lib/features";
import { ReservationsManager } from "./reservations-manager";

export default async function ReservationsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  await requireModuleForPage(session.businessId, "reservations");
  await requireFeatureForPage(session.businessId, "reservations");

  const canBook = ["owner", "manager", "cashier"].includes(session.role);

  return <ReservationsManager canBook={canBook} />;
}
