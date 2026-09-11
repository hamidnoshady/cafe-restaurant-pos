import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { GrowthSection } from "../growth-section";

/** Growth → Loyalty & Store Credit. Open to owner, manager and cashier. */
export default async function GrowthLoyaltyPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!["owner", "manager", "cashier"].includes(session.role)) redirect("/dashboard");

  return <GrowthSection section="loyalty" role={session.role} />;
}
