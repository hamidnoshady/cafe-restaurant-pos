import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { BillingManager } from "./billing-manager";

export const metadata = { title: "اعتبار و پرداخت‌ها" };

export default async function BillingPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  // Only owner/manager spend business money / buy plans.
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");
  return <BillingManager />;
}
