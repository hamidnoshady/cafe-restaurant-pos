import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { formatToman } from "@/lib/money";

export default function DashboardPage() {
  const today = toPersianDigits(formatJalali(new Date(), { withMonthName: true }));

  return (
    <div>
      <header className="mb-6 flex items-baseline justify-between">
        <h1 className="text-2xl font-bold">داشبورد</h1>
        <p className="text-sm text-stone-500">امروز: {today}</p>
      </header>

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
