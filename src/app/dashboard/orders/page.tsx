import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { OrdersList } from "./orders-list";

export default async function OrdersPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!["owner", "manager", "cashier", "waiter"].includes(session.role)) redirect("/dashboard");

  return (
    <div className="mx-auto w-full max-w-5xl">
      <header className="mb-5 border-b border-border/80 pb-4">
        <h1 className="text-2xl font-bold">سفارش‌های باز</h1>
      </header>
      <OrdersList />
    </div>
  );
}
