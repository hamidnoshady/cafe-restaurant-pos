import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireModuleForPage } from "@/lib/industry-guard";
import { requireFeatureForPage } from "@/lib/features";
import { PageHeader, PageShell } from "../page-chrome";
import { KnowledgeHelpButton } from "../knowledge-help";
import { DeliveryBoard } from "./delivery-board";

export default async function DeliveryPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  await requireModuleForPage(session.businessId, "delivery");
  if (!["owner", "manager", "cashier"].includes(session.role)) redirect("/dashboard");
  await requireFeatureForPage(session.businessId, "delivery");

  const canManageCouriers = session.role === "owner" || session.role === "manager";

  return (
    <PageShell>
      <PageHeader
        title="ارسال و پیک"
        description="تخصیص سفارش‌های ارسالی به پیک‌ها و پیگیری وضعیت تحویل."
        actions={<KnowledgeHelpButton section="delivery" />}
      />
      <DeliveryBoard canManageCouriers={canManageCouriers} />
    </PageShell>
  );
}
