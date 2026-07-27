import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireFeatureForPage } from "@/lib/features";
import { ReportsManager } from "./reports-manager";

export default async function ReportsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!["owner", "manager", "accountant"].includes(session.role)) redirect("/dashboard");
  await requireFeatureForPage(session.businessId, "reporting");

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-bold">گزارش‌ها</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          گزارش‌های آمادهٔ فروش، انبار، حسابداری و کارکنان، به‌همراه گزارش‌ساز برای ساخت گزارش سفارشی.
        </p>
      </header>
      <ReportsManager role={session.role} />
    </div>
  );
}
