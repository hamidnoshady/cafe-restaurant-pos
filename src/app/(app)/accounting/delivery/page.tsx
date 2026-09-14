import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireFeatureForPage } from "@/lib/features";
import { requireModuleForPage } from "@/lib/industry-guard";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { DeliveryBoard } from "@/app/dashboard/delivery/delivery-board";

export default async function DeliveryPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  await requireModuleForPage(session.businessId, "delivery");
  if (!["owner", "manager", "cashier"].includes(session.role)) redirect("/dashboard");
  await requireFeatureForPage(session.businessId, "delivery");

  return (
    <PageShell>
      <PageHeader
        title="ارسال و پیک"
        description="تخصیص سفارش‌های ارسالی به پیک‌ها و پیگیری وضعیت تحویل."
        actions={<KnowledgeHelpButton section="delivery" />}
      />
      <DeliveryBoard canManageCouriers={session.role === "owner" || session.role === "manager"} />
    </PageShell>
  );
}
