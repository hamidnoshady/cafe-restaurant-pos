import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireIndustryForPage } from "@/lib/industry-guard";
import { PageHeader, PageShell } from "../page-chrome";
import { KnowledgeHelpButton } from "../knowledge-help";
import { CosmeticsManager } from "./cosmetics-manager";

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
