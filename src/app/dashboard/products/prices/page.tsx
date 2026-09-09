import { PageHeader, PageShell } from "../../page-chrome";
import { KnowledgeHelpButton } from "../../knowledge-help";
import { requireProductWorkspace } from "../workspace-context";
import { PriceListsSection } from "../price-lists-section";

/** «لیست قیمت» — the price-update matrix over sale/purchase and named lists. */
export default async function PriceListsPage() {
  const { apiBase } = await requireProductWorkspace();
  return (
    <PageShell>
      <PageHeader
        title="بروزرسانی قیمت‌ها"
        description="نمایش لیست قیمت‌های کالا — ستون‌های قیمت فروش و خرید و لیست‌های قیمت نام‌دار، با بروزرسانی سریع و ذخیرهٔ یکجا."
        actions={<KnowledgeHelpButton section="pos" />}
      />
      <PriceListsSection apiBase={apiBase} />
    </PageShell>
  );
}
