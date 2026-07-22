import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { ThemeToggle } from "@/components/theme-toggle";
import { LogoutButton } from "./logout-button";
import { OfflineBanner } from "./offline-banner";

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
  { label: "میزها", href: "/dashboard/floor", roles: ["owner", "manager", "cashier", "waiter"] },
  { label: "میزهای من", href: "/dashboard/waiter", roles: ["owner", "manager", "waiter"] },
  { label: "آشپزخانه", href: "/dashboard/kitchen", roles: ["owner", "manager", "kitchen"] },
  { label: "رزروها", href: "/dashboard/reservations", roles: ["owner", "manager", "cashier", "waiter"] },
  { label: "ارسال و پیک", href: "/dashboard/delivery", roles: ["owner", "manager", "cashier"] },
  { label: "انبار", href: "/dashboard/inventory", roles: ["owner", "manager"] },
  { label: "حسابداری", href: "/dashboard/ledger", roles: ["owner", "manager"] },
  { label: "گزارش‌ها", href: "/dashboard/reports", roles: ["owner", "manager"] },
  { label: "شعبه‌ها", href: "/dashboard/locations", roles: ["owner"] },
  { label: "پشتیبان‌گیری", href: "/dashboard/backup", roles: ["owner", "manager"] },
  { label: "تنظیمات", href: "/setup", roles: ["owner", "manager"] },
];

export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <div className="flex min-h-screen">
      {/* Sidebar sits on the inline-start side (right in RTL) */}
      <aside className="flex w-56 shrink-0 flex-col border-e bg-card">
        <div className="flex items-start justify-between border-b p-4">
          <div>
            <p className="font-bold">کافه و رستوران</p>
            <p className="text-xs text-muted-foreground">نسخهٔ آزمایشی</p>
          </div>
          <ThemeToggle />
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {NAV_ITEMS.map((item) => {
            const allowed = !item.roles || item.roles.includes(session.role);
            if (item.href && allowed) {
              return (
                <Link
                  key={item.label}
                  href={item.href}
                  className="block rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                >
                  {item.label}
                </Link>
              );
            }
            return (
              <span
                key={item.label}
                className="block cursor-default rounded-lg px-3 py-2 text-sm text-muted-foreground/50"
              >
                {item.label}
              </span>
            );
          })}
        </nav>
        <div className="border-t p-4 text-sm">
          <p className="font-semibold">{session.fullName}</p>
          <p className="mb-3 text-xs text-muted-foreground">
            {ROLE_LABELS[session.role] ?? session.role}
          </p>
          <LogoutButton />
        </div>
      </aside>

      <div className="flex flex-1 flex-col overflow-hidden">
        <OfflineBanner />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
