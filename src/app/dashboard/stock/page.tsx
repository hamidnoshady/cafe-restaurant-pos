import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireModuleForPage } from "@/lib/industry-guard";
import { PageHeader, PageShell } from "../page-chrome";
import { KnowledgeHelpButton } from "../knowledge-help";
import { StockManager } from "./stock-manager";

/**
 * Phase 42b — «خرید و انبار» as the RETAIL warehouse module: warehouses
 * (branches), warehouse documents (رسید/حواله), stock levels, the count, and
 * the pre-existing retail operations (خرید، حواله بازگشت، گزارش), on the
 * items/item_stock/item_batches model. F&B's own warehouse module
 * (/dashboard/inventory) is untouched.
 */
export default async function StockPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");
  await requireModuleForPage(session.businessId, "stock");

  return (
    <PageShell>
      <PageHeader
        title="خرید و انبار"
        description="انبارها و موجودی آن‌ها، سندهای رسید و حوالهٔ انبار، انبارگردانی، خرید، برگشت به تأمین‌کننده و گزارش کمبود/راکد موجودی."
        actions={<KnowledgeHelpButton section="stock" />}
      />
      <StockManager />
    </PageShell>
  );
}
