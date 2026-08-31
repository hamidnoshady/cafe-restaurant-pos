import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { WpOverviewSection } from "./overview-section";

/** The WordPress & WooCommerce Manager — میز کار. */
export default async function WpManagerPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");

  return <WpOverviewSection />;
}
