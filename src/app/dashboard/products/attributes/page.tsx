import { PageHeader, PageShell } from "../../page-chrome";
import { KnowledgeHelpButton } from "../../knowledge-help";
import { requireProductWorkspace } from "../workspace-context";
import { AttributesSection } from "../attributes-section";

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
