import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireModuleForPage } from "@/lib/industry-guard";
import { requireFeatureForPage } from "@/lib/features";
import { InventoryManager } from "./inventory-manager";

export default async function InventoryPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  await requireModuleForPage(session.businessId, "inventory");
  if (session.role !== "owner" && session.role !== "manager")
    redirect("/dashboard");
  await requireFeatureForPage(session.businessId, "inventory");

  return (
    <div className="mx-auto w-full max-w-[1600px]">
      <header className="mb-5 border-b border-stone-200/80 pb-5 sm:mb-6 sm:pb-6">
        <h1 className="text-2xl font-bold tracking-tight text-stone-950 sm:text-[1.7rem]">
          انبار
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          اقلام انبار، دستورالعمل مصرف (رسپی)، تأمین‌کنندگان، خرید، ضایعات و
          شمارش فیزیکی.
        </p>
      </header>
      <InventoryManager />
    </div>
  );
}
