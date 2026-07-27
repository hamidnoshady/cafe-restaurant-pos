import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireFeatureForPage } from "@/lib/features";
import { DeliveryBoard } from "./delivery-board";

export default async function DeliveryPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!["owner", "manager", "cashier"].includes(session.role)) redirect("/dashboard");
  await requireFeatureForPage(session.businessId, "delivery");

  const canManageCouriers = session.role === "owner" || session.role === "manager";

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-bold">ارسال و پیک</h1>
        <p className="text-sm text-muted-foreground">تخصیص سفارش‌های ارسالی به پیک‌ها و پیگیری وضعیت تحویل.</p>
      </header>
      <DeliveryBoard canManageCouriers={canManageCouriers} />
    </div>
  );
}
