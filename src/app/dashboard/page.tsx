import Link from "next/link";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { formatToman } from "@/lib/money";
import { getSession } from "@/lib/auth";
import { isSetupComplete } from "@/lib/setup-state";

export default async function DashboardPage() {
  const today = toPersianDigits(formatJalali(new Date(), { withMonthName: true }));
  const session = await getSession();
  const canSetup = session?.role === "owner" || session?.role === "manager";
  const setupDone = session ? await isSetupComplete(session.businessId) : true;

  return (
    <div>
      <header className="mb-6 flex items-baseline justify-between">
        <h1 className="text-2xl font-bold">داشبورد</h1>
        <p className="text-sm text-stone-500">امروز: {today}</p>
      </header>

      {canSetup && !setupDone ? (
        <Link
          href="/setup"
          className="mb-6 flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900 transition hover:bg-amber-100"
        >
          <span>
            <b>راه‌اندازی اولیه کامل نشده است.</b> برای آماده‌شدن جهت ثبت سفارش، جادوگر راه‌اندازی را
            تکمیل کنید.
          </span>
          <span className="font-semibold">ادامهٔ راه‌اندازی ←</span>
        </Link>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard title="فروش امروز" value={formatToman(0)} />
        <StatCard title="سفارش‌های باز" value="—" />
        <StatCard title="میزهای فعال" value="—" />
      </div>

      <p className="mt-8 text-sm text-stone-400">
        اسکلت اولیه (فاز صفر) — امکانات فروش در فازهای بعدی اضافه می‌شود.
      </p>
    </div>
  );
}

function StatCard({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-2xl bg-white p-5 shadow-sm">
      <p className="mb-2 text-sm text-stone-500">{title}</p>
      <p className="text-xl font-bold">{value}</p>
    </div>
  );
}
