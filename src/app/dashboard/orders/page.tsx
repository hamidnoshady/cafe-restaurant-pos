import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireModuleForPage } from "@/lib/industry-guard";
import { OrdersList } from "./orders-list";

export default async function OrdersPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  await requireModuleForPage(session.businessId, "orders");
  if (!["owner", "manager", "cashier", "waiter"].includes(session.role))
    redirect("/dashboard");

  return <OrdersList />;
}
