import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { InventoryManager } from "./inventory-manager";

export default async function InventoryPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-bold">انبار</h1>
        <p className="mt-1 text-sm text-stone-500">
          اقلام انبار، دستورالعمل مصرف (رسپی)، تأمین‌کنندگان، خرید، ضایعات و شمارش فیزیکی.
        </p>
      </header>
      <InventoryManager />
    </div>
  );
}
