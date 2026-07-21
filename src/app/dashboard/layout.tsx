import Link from "next/link";
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

interface NavItem {
  label: string;
  href?: string;
  roles?: string[];
}

const NAV_ITEMS: NavItem[] = [
  { label: "داشبورد", href: "/dashboard" },
  { label: "سفارش‌ها", href: "/dashboard/orders", roles: ["owner", "manager", "cashier", "waiter"] },
  { label: "صندوق (فروش)", href: "/dashboard/pos", roles: ["owner", "manager", "cashier"] },
  { label: "منو", href: "/dashboard/menu", roles: ["owner", "manager"] },
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
          {NAV_ITEMS.map((item) => {
            const allowed = !item.roles || item.roles.includes(session.role);
            if (item.href && allowed) {
              return (
                <Link
                  key={item.label}
                  href={item.href}
                  className="block rounded-lg px-3 py-2 text-sm text-stone-600 transition hover:bg-amber-50 hover:text-amber-800"
                >
                  {item.label}
                </Link>
              );
            }
            return (
              <span key={item.label} className="block cursor-default rounded-lg px-3 py-2 text-sm text-stone-400">
                {item.label}
              </span>
            );
          })}
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
