import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForPage } from "@/lib/industry-guard";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { JewelryManager } from "@/app/dashboard/jewelry/jewelry-manager";

export default async function JewelryPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  const permissions = access?.permissions ?? new Set<string>();
  if (!permissions.has(PERMISSIONS.inventoryAdjust)) redirect("/dashboard");
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
