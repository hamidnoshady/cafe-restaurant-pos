import { PageHeader, PageShell } from "../../page-chrome";
import { KnowledgeHelpButton } from "../../knowledge-help";
import { requireProductWorkspace } from "../workspace-context";
import { ProductAddSection } from "../product-add-section";

/** «افزودن محصول» — the tabbed product form with drafts and variant rows. */
export default async function ProductAddPage() {
  const { apiBase } = await requireProductWorkspace();
  return (
    <PageShell>
      <PageHeader
        title="افزودن محصول"
        description="ثبت خانوادهٔ کالا با قیمت‌گذاری، واحدها، سفارش، مالیات و ویژگی‌های تنوع — پیش‌نویس‌ها روی همین دستگاه می‌مانند."
        actions={<KnowledgeHelpButton section="pos" />}
      />
      <ProductAddSection apiBase={apiBase} />
    </PageShell>
  );
}
