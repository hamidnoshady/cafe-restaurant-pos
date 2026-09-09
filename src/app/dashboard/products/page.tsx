import { PageHeader, PageShell } from "../page-chrome";
import { KnowledgeHelpButton } from "../knowledge-help";
import { requireProductWorkspace } from "./workspace-context";
import { ProductsListSection } from "./products-list-section";

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
