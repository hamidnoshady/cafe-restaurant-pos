import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { effectiveFeatures, requireFeatureForPage } from "@/lib/features";
import { PageHeader, PageShell } from "../page-chrome";
import { ReportsManager } from "./reports-manager";

export default async function ReportsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!["owner", "manager", "accountant"].includes(session.role))
    redirect("/dashboard");
  await requireFeatureForPage(session.businessId, "reporting");
  const features = await effectiveFeatures(session.businessId);

  return (
    <PageShell>
      <PageHeader
        title="گزارش‌ها"
        description="گزارش‌های آمادهٔ فروش، انبار، حسابداری و کارکنان، به‌همراه گزارش‌ساز برای ساخت گزارش سفارشی."
      />
      <ReportsManager
        role={session.role}
        canExplain={(session.role === "owner" || session.role === "manager") && features.ai_assistant}
      />
    </PageShell>
  );
}
