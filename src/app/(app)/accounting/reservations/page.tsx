import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS } from "@/lib/permissions";
import { requireFeatureForPage } from "@/lib/features";
import { requireModuleForPage } from "@/lib/industry-guard";
import { ReservationsManager } from "@/app/dashboard/reservations/reservations-manager";

export default async function ReservationsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  await requireModuleForPage(session.businessId, "reservations");
  await requireFeatureForPage(session.businessId, "reservations");

  const access = await memberAccessFor(session);
  const permissions = access?.permissions ?? new Set<string>();
  // Reading the book and writing in it are different keys, because they were
  // always different audiences: `GET /api/reservations` admitted the waiter and
  // `POST` did not. Offering a «رزرو جدید» button that 403s is worse than not
  // offering it.
  if (!permissions.has(PERMISSIONS.reservationsView)) redirect("/dashboard");

  return <ReservationsManager canBook={permissions.has(PERMISSIONS.reservationsManage)} />;
}
