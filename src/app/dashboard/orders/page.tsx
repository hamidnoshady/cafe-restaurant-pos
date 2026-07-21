import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { OrdersList } from "./orders-list";

export default async function OrdersPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!["owner", "manager", "cashier", "waiter"].includes(session.role)) redirect("/dashboard");

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-bold">سفارش‌های باز</h1>
      </header>
      <OrdersList />
    </div>
  );
}
