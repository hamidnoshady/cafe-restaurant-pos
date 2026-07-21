import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { OrderDetail } from "./order-detail";

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!["owner", "manager", "cashier", "waiter"].includes(session.role)) redirect("/dashboard");
  const { id } = await params;

  return <OrderDetail orderId={id} canEdit={["owner", "manager", "cashier"].includes(session.role)} />;
}
