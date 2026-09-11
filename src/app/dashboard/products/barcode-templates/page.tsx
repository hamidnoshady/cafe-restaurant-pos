import { PageHeader, PageShell } from "../../page-chrome";
import { KnowledgeHelpButton } from "../../knowledge-help";
import { requireProductWorkspace } from "../workspace-context";
import { BarcodeTemplatesSection } from "../barcode-templates-section";

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
