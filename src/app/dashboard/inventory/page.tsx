import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireModuleForPage } from "@/lib/industry-guard";
import { requireFeatureForPage } from "@/lib/features";
import { PageHeader, PageShell } from "../page-chrome";
import { InventoryManager } from "./inventory-manager";

export default async function InventoryPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  await requireModuleForPage(session.businessId, "inventory");
  if (session.role !== "owner" && session.role !== "manager")
    redirect("/dashboard");
  await requireFeatureForPage(session.businessId, "inventory");

  return (
    <PageShell>
      <PageHeader
        title="انبار"
        description="اقلام انبار، دستورالعمل مصرف (رسپی)، تأمین‌کنندگان، خرید، ضایعات و شمارش فیزیکی."
      />
      <InventoryManager />
    </PageShell>
  );
}
