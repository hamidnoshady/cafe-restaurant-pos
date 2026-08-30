import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireIndustryForPage } from "@/lib/industry-guard";
import { PageHeader, PageShell } from "../page-chrome";
import { KnowledgeHelpButton } from "../knowledge-help";
import { AccessoriesManager } from "./accessories-manager";

export default async function AccessoriesPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");
  await requireIndustryForPage(session.businessId, "accessories");

  return (
    <PageShell>
      <PageHeader
        title="بدلیجات"
        description="خانواده‌های کالا و تنوع‌های آن‌ها (رنگ، سایز، …)، موجودی و قیمت هر تنوع، و فروش."
        actions={<KnowledgeHelpButton section="accessories" />}
      />
      <AccessoriesManager />
    </PageShell>
  );
}
