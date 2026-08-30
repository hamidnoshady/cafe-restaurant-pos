import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireIndustryForPage } from "@/lib/industry-guard";
import { PageHeader, PageShell } from "../page-chrome";
import { KnowledgeHelpButton } from "../knowledge-help";
import { TradeGoodsManager } from "../trade-goods-manager";

export default async function ToolsFittingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");
  await requireIndustryForPage(session.businessId, "tools_fittings");

  return (
    <PageShell>
      <PageHeader
        title="ابزار و یراق‌آلات"
        description="خانواده‌های کالای ابزار و یراق و تنوع‌هایشان، موجودی و قیمت، و فروش با فاکتور."
        actions={<KnowledgeHelpButton section="pos" />}
      />
      <TradeGoodsManager
        apiBase="/api/tools-fittings"
        idPrefix="tools-fittings"
        navLabel="بخش‌های ابزار و یراق‌آلات"
        errorTitle="ابزار و یراق‌آلات"
      />
    </PageShell>
  );
}
