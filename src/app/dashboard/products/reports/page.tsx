import { PageHeader, PageShell } from "../../page-chrome";
import { KnowledgeHelpButton } from "../../knowledge-help";
import { requireProductWorkspace } from "../workspace-context";
import { ReportsSection } from "../../accessories/reports-section";

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
