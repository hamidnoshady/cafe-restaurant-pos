import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { LogoutButton } from "./logout-button";

const ROLE_LABELS: Record<string, string> = {
  owner: "مالک",
  manager: "مدیر",
  cashier: "صندوق‌دار",
  waiter: "گارسون",
  kitchen: "آشپزخانه",
};

const NAV_ITEMS = [
  { label: "داشبورد", active: true },
  { label: "سفارش‌ها" },
  { label: "منو" },
  { label: "میزها" },
  { label: "انبار" },
  { label: "حسابداری" },
  { label: "گزارش‌ها" },
  { label: "تنظیمات" },
];

export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <div className="flex min-h-screen">
      {/* Sidebar sits on the inline-start side (right in RTL) */}
      <aside className="flex w-56 shrink-0 flex-col border-e border-stone-200 bg-white">
        <div className="border-b border-stone-200 p-4">
          <p className="font-bold">کافه و رستوران</p>
          <p className="text-xs text-stone-500">نسخهٔ آزمایشی</p>
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {NAV_ITEMS.map((item) => (
            <span
              key={item.label}
              className={`block rounded-lg px-3 py-2 text-sm ${
                item.active
                  ? "bg-amber-50 font-semibold text-amber-800"
                  : "cursor-default text-stone-400"
              }`}
            >
              {item.label}
            </span>
          ))}
        </nav>
        <div className="border-t border-stone-200 p-4 text-sm">
          <p className="font-semibold">{session.fullName}</p>
          <p className="mb-3 text-xs text-stone-500">
            {ROLE_LABELS[session.role] ?? session.role}
          </p>
          <LogoutButton />
        </div>
      </aside>

      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
