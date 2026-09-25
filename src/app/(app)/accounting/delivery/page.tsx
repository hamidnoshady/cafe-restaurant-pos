import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS } from "@/lib/permissions";
import { requireFeatureForPage } from "@/lib/features";
import { requireModuleForPage } from "@/lib/industry-guard";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { DeliveryBoard } from "@/app/dashboard/delivery/delivery-board";

export default async function DeliveryPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  await requireModuleForPage(session.businessId, "delivery");
  const access = await memberAccessFor(session);
  const permissions = access?.permissions ?? new Set<string>();
  if (!permissions.has(PERMISSIONS.deliveryManage)) redirect("/dashboard");
  await requireFeatureForPage(session.businessId, "delivery");

  return (
    <PageShell>
      <PageHeader
        title="ارسال و پیک"
        description="تخصیص سفارش‌های ارسالی به پیک‌ها و پیگیری وضعیت تحویل."
        actions={<KnowledgeHelpButton section="delivery" />}
      />
      {/*
        Dispatching a delivery is `delivery.manage`; maintaining the courier
        roster is master data, so it is `settings.manage` — the same split
        `/api/couriers` enforces between its GET and its writes.
      */}
      <DeliveryBoard canManageCouriers={permissions.has(PERMISSIONS.settingsManage)} />
    </PageShell>
  );
}
