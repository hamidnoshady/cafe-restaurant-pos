import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { ProductsListSection } from "@/app/dashboard/products/products-list-section";
import { requireProductWorkspace } from "@/app/dashboard/products/workspace-context";

/** «لیست محصولات» — the catalogue board as a filterable, paginated table. */
export default async function ProductsListPage() {
  const { apiBase } = await requireProductWorkspace();
  return (
    <PageShell>
      <PageHeader
        title="محصولات"
        description="نمایش کالاها و تنوع‌هایشان با موجودی، قیمت و بارکد — همان برد کالای صنف، با درِ مشترک محصولات."
        actions={<KnowledgeHelpButton section="pos" />}
      />
      <ProductsListSection apiBase={apiBase} />
    </PageShell>
  );
}
