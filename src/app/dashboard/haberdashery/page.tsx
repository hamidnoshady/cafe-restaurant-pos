import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireIndustryForPage } from "@/lib/industry-guard";
import { PageHeader, PageShell } from "../page-chrome";
import { KnowledgeHelpButton } from "../knowledge-help";
import { TradeGoodsManager } from "../trade-goods-manager";

export default async function HaberdasheryPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");
  await requireIndustryForPage(session.businessId, "haberdashery");

  return (
    <PageShell>
      <PageHeader
        title="خرازی"
        description="خانواده‌های لوازم خیاطی و تنوع‌هایشان، موجودی و قیمت، و فروش با فاکتور."
        actions={<KnowledgeHelpButton section="pos" />}
      />
      <TradeGoodsManager
        apiBase="/api/haberdashery"
        idPrefix="haberdashery"
        navLabel="بخش‌های خرازی"
        errorTitle="خرازی"
      />
    </PageShell>
  );
}
