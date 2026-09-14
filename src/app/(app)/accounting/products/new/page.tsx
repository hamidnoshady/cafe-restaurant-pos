import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { ProductAddSection } from "@/app/dashboard/products/product-add-section";
import { requireProductWorkspace } from "@/app/dashboard/products/workspace-context";

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
