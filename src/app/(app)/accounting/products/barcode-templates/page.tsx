import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { BarcodeTemplatesSection } from "@/app/dashboard/products/barcode-templates-section";
import { requireProductWorkspace } from "@/app/dashboard/products/workspace-context";

/** «الگوی بارکد وزنی» — weight barcode patterns with a live label preview. */
export default async function BarcodeTemplatesPage() {
  await requireProductWorkspace();
  return (
    <PageShell>
      <PageHeader
        title="تنظیمات الگو بارکد زنی"
        description="الگوهای بارکد وزنی EAN-13: پیش‌شمارهٔ ثابت و واحد سنجش وزن، با پیش‌نمایش زندهٔ برچسب."
        actions={<KnowledgeHelpButton section="pos" />}
      />
      <BarcodeTemplatesSection />
    </PageShell>
  );
}
