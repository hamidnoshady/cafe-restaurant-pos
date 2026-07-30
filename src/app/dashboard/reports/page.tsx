import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireFeatureForPage } from "@/lib/features";
import { ReportsManager } from "./reports-manager";

export default async function ReportsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!["owner", "manager", "accountant"].includes(session.role))
    redirect("/dashboard");
  await requireFeatureForPage(session.businessId, "reporting");

  return (
    <div className="mx-auto max-w-[1600px]">
      <header className="mb-6 border-b border-[#EEECE7] pb-5 sm:mb-8 sm:pb-6">
        <p className="text-xs font-semibold text-[#9B6700]">گزارش‌ها و تحلیل</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-[#252522] sm:text-[28px]">
          گزارش‌ها
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-[#77756F]">
          گزارش‌های آمادهٔ فروش، انبار، حسابداری و کارکنان، به‌همراه گزارش‌ساز
          برای ساخت گزارش سفارشی.
        </p>
      </header>
      <ReportsManager role={session.role} />
    </div>
  );
}
