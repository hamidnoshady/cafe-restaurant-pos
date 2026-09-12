import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { OrdersSectionHost } from "../store-section-host";

/** سفارش‌های فروشگاه: تغییر وضعیت و برگشت وجه، از طریق صف عملیات. */
export default async function WpOrdersPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");
  return <OrdersSectionHost />;
}
