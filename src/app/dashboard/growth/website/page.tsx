import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { WebsiteSection } from "../website-section";

/**
 * The Growth app's website manager — «وب‌سایت» (issue #378).
 *
 * Owner/manager only (like the connections app it shares its credential
 * model with); a cashier lands in their one floor surface instead.
 */
export default async function GrowthWebsitePage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role === "cashier") redirect("/dashboard/growth/loyalty");
  if (!["owner", "manager", "cashier"].includes(session.role)) redirect("/dashboard");

  return <WebsiteSection />;
}
