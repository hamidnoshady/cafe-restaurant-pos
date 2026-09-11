import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireModuleForPage } from "@/lib/industry-guard";
import { requireFeatureForPage } from "@/lib/features";
import { PageHeader, PageShell } from "../page-chrome";
import { KnowledgeHelpButton } from "../knowledge-help";
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
        description="انبارها و موجودی آن‌ها، انبارگردانی، سندهای رسید و حواله، اقلام، دستورالعمل مصرف، خرید، ضایعات و سایر عملیات انبار."
        actions={<KnowledgeHelpButton section="inventory" />}
      />
      <InventoryManager role={session.role} />
    </PageShell>
  );
}
