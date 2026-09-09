import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { GrowthSection } from "../growth-section";

/** Growth → Seller Commission. Owner/manager only (compensation data). */
export default async function GrowthCommissionPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role === "cashier") redirect("/dashboard/growth/loyalty");
  if (!["owner", "manager"].includes(session.role)) redirect("/dashboard");

  return <GrowthSection section="commission" role={session.role} />;
}
