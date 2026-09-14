import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { ReportsSection } from "@/app/dashboard/accessories/reports-section";
import { requireProductWorkspace } from "@/app/dashboard/products/workspace-context";

/** «گزارش‌ها» — the trade's sales-by-variant report, kept in the group. */
export default async function ProductsReportsPage() {
  const { apiBase } = await requireProductWorkspace();
  return (
    <PageShell>
      <PageHeader
        title="گزارش‌های کالا"
        description="فروش تنوع‌ها و خانواده‌های کالا — همان گزارش صنف، پشت درِ مشترک محصولات."
        actions={<KnowledgeHelpButton section="pos" />}
      />
      <ReportsSection apiBase={apiBase} />
    </PageShell>
  );
}
