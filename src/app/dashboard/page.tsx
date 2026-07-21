import Link from "next/link";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { getSession } from "@/lib/auth";
import { isSetupComplete } from "@/lib/setup-state";
import { DashboardGrid } from "./dashboard-grid";

export default async function DashboardPage() {
  const today = toPersianDigits(formatJalali(new Date(), { withMonthName: true }));
  const session = await getSession();
  const canSetup = session?.role === "owner" || session?.role === "manager";
  const setupDone = session ? await isSetupComplete(session.businessId) : true;

  return (
    <div>
      <header className="mb-6 flex items-baseline justify-between">
        <h1 className="text-2xl font-bold">داشبورد</h1>
        <p className="text-sm text-muted-foreground">امروز: {today}</p>
      </header>

      {canSetup && !setupDone ? (
        <Link
          href="/setup"
          className="mb-6 flex items-center justify-between rounded-xl border border-primary/30 bg-primary/5 px-5 py-4 text-sm text-primary transition hover:bg-primary/10"
        >
          <span>
            <b>راه‌اندازی اولیه کامل نشده است.</b> برای آماده‌شدن جهت ثبت سفارش، جادوگر راه‌اندازی را
            تکمیل کنید.
          </span>
          <span className="font-semibold">ادامهٔ راه‌اندازی ←</span>
        </Link>
      ) : null}

      <DashboardGrid canEdit={canSetup} />
    </div>
  );
}
