import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { GrowthSection } from "../growth-section";

/** Growth → Gift Cards. Owner/manager only. */
export default async function GrowthGiftCardsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role === "cashier") redirect("/growth/loyalty");
  if (!["owner", "manager"].includes(session.role)) redirect("/dashboard");

  return <GrowthSection section="gift-cards" role={session.role} />;
}
