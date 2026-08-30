import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireIndustryForPage } from "@/lib/industry-guard";
import { PageHeader, PageShell } from "../page-chrome";
import { KnowledgeHelpButton } from "../knowledge-help";
import { TradeGoodsManager } from "../trade-goods-manager";

export default async function WholesalePage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");
  await requireIndustryForPage(session.businessId, "wholesale");

  return (
    <PageShell>
      <PageHeader
        title="عمده‌فروشی"
        description="خانواده‌های کالای عمده و تنوع‌هایشان، موجودی و قیمت هر تنوع، و فروش با فاکتور."
        actions={<KnowledgeHelpButton section="pos" />}
      />
      <TradeGoodsManager
        apiBase="/api/wholesale"
        idPrefix="wholesale"
        navLabel="بخش‌های عمده‌فروشی"
        errorTitle="عمده‌فروشی"
      />
    </PageShell>
  );
}
