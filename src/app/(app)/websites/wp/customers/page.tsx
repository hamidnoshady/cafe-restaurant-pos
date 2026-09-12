import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { WpCustomersSection } from "../customers-section";

/** مشتریان فروشگاه، متصل به پروندهٔ مشتریان CRM. */
export default async function WpCustomersPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");
  return <WpCustomersSection />;
}
