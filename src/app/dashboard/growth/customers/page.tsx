import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { GrowthCustomersSection } from "../customers-section";
import { canViewGrowthSection } from "../growth-routes";

/** Growth's own customers screen — its lifecycle/purchase columns, managed here on the shared record. */
export default async function GrowthCustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!canViewGrowthSection(session.role, "customers")) redirect("/dashboard/growth/loyalty");

  const { customerId } = await searchParams;
  return <GrowthCustomersSection selectedCustomerId={customerId} role={session.role} />;
}
