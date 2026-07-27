import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { effectiveFeatures } from "@/lib/features";
import { AiAssistant } from "@/components/ai/ai-assistant";
import { OfflineBanner } from "./offline-banner";
import { DashboardSidebar, type NavItem } from "./dashboard-sidebar";

const NAV_ITEMS: NavItem[] = [
  { label: "داشبورد", href: "/dashboard" },
  { label: "سفارش‌ها", href: "/dashboard/orders", roles: ["owner", "manager", "cashier", "waiter"] },
  { label: "صندوق (فروش)", href: "/dashboard/pos", roles: ["owner", "manager", "cashier"] },
  { label: "منو", href: "/dashboard/menu", roles: ["owner", "manager"] },
  { label: "میزها", href: "/dashboard/floor", roles: ["owner", "manager", "cashier", "waiter"], flag: "reservations" },
  { label: "میزهای من", href: "/dashboard/waiter", roles: ["owner", "manager", "waiter"], flag: "reservations" },
  { label: "آشپزخانه", href: "/dashboard/kitchen", roles: ["owner", "manager", "kitchen"] },
  { label: "رزروها", href: "/dashboard/reservations", roles: ["owner", "manager", "cashier", "waiter"], flag: "reservations" },
  { label: "ارسال و پیک", href: "/dashboard/delivery", roles: ["owner", "manager", "cashier"], flag: "delivery" },
  { label: "انبار", href: "/dashboard/inventory", roles: ["owner", "manager"], flag: "inventory" },
  { label: "حسابداری", href: "/dashboard/ledger", roles: ["owner", "manager", "accountant"], flag: "ledger" },
  { label: "گزارش‌ها", href: "/dashboard/reports", roles: ["owner", "manager", "accountant"], flag: "reporting" },
  { label: "اعضای تیم", href: "/dashboard/team", roles: ["owner"] },
  { label: "مدیریت شعب", href: "/dashboard/branches", roles: ["owner"], flag: "multi_location" },
  { label: "همگام‌سازی شعبه‌ها", href: "/dashboard/locations", roles: ["owner"], flag: "offline_mode" },
  { label: "پشتیبان‌گیری", href: "/dashboard/backup", roles: ["owner", "manager"], flag: "backup" },
  { label: "دستیار هوشمند", href: "/dashboard/ai", roles: ["owner", "manager"], flag: "ai_assistant" },
  { label: "تنظیمات", href: "/setup", roles: ["owner", "manager"] },
];

export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await getSession();
  if (!session) redirect("/login");

  const features = await effectiveFeatures(session.businessId);
  const navItems = NAV_ITEMS.filter((item) => !item.flag || features[item.flag]);

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      {/* Collapsible on mobile (drawer), fixed rail on desktop. Sits inline-start (right in RTL). */}
      <DashboardSidebar navItems={navItems} role={session.role} fullName={session.fullName} />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <OfflineBanner />
        <main className="flex-1 overflow-y-auto p-2 md:p-4">{children}</main>
      </div>

      {(session.role === "owner" || session.role === "manager") && features.ai_assistant && (
        <AiAssistant mode="dashboard" />
      )}
    </div>
  );
}
