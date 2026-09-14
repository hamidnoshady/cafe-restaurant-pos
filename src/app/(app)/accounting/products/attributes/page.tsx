import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { AttributesSection } from "@/app/dashboard/products/attributes-section";
import { requireProductWorkspace } from "@/app/dashboard/products/workspace-context";

/** «ویژگی محصول» — the attribute master: cards, add and edit. */
export default async function AttributesPage() {
  await requireProductWorkspace();
  return (
    <PageShell>
      <PageHeader
        title="ویژگی محصول"
        description="نمایش و ویرایش ویژگی‌های محصول کسب‌وکار — رنگ، برند و هر ویژگی دیگری با مقدارهای مجازش."
        actions={<KnowledgeHelpButton section="pos" />}
      />
      <AttributesSection />
    </PageShell>
  );
}
