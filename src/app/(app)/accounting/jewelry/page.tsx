import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireIndustryForPage } from "@/lib/industry-guard";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { JewelryManager } from "@/app/dashboard/jewelry/jewelry-manager";

export default async function JewelryPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");
  await requireIndustryForPage(session.businessId, "jewelry");

  return (
    <PageShell>
      <PageHeader
        title="طلا و جواهر"
        description="کالاهای وزنی، نرخ روز طلا، امانت‌گذاران و فروش قطعات طلا."
        actions={<KnowledgeHelpButton section="jewelry" />}
      />
      <JewelryManager />
    </PageShell>
  );
}
