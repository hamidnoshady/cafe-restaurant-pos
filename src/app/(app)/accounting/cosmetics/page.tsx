import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireIndustryForPage } from "@/lib/industry-guard";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { CosmeticsManager } from "@/app/dashboard/cosmetics/cosmetics-manager";

export default async function CosmeticsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");
  await requireIndustryForPage(session.businessId, "cosmetics");

  return (
    <PageShell>
      <PageHeader
        title="آرایشی و بهداشتی"
        description="خانواده‌های کالا و تنوع‌های آن‌ها (سایه، حجم، …)، موجودی و قیمت هر تنوع، و فروش."
        actions={<KnowledgeHelpButton section="cosmetics" />}
      />
      <CosmeticsManager />
    </PageShell>
  );
}
