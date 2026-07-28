import { redirect } from "next/navigation";
import { getSession, type Role } from "@/lib/auth";
import { query, withTenant } from "@/lib/db";
import { effectiveFeatures } from "@/lib/features";
import { effectivePermissions, parseOverrides, type Permission } from "@/lib/permissions";
import { visibleSettingsTabs } from "@/lib/settings-tabs";
import { AiAssistant } from "@/components/ai/ai-assistant";
import { OfflineBanner } from "./offline-banner";
import { DashboardSidebar, type NavItem } from "./dashboard-sidebar";

const NAV_ITEMS: NavItem[] = [
  { label: "داشبورد", href: "/dashboard" },
  { label: "سفارش‌ها", href: "/dashboard/orders", roles: ["owner", "manager", "cashier", "waiter"] },
  { label: "صندوق (فروش)", href: "/dashboard/pos", roles: ["owner", "manager", "cashier"] },
  { label: "میزها", href: "/dashboard/floor", roles: ["owner", "manager", "cashier", "waiter"], flag: "reservations" },
  { label: "میزهای من", href: "/dashboard/waiter", roles: ["owner", "manager", "waiter"], flag: "reservations" },
  { label: "آشپزخانه", href: "/dashboard/kitchen", roles: ["owner", "manager", "kitchen"] },
  { label: "رزروها", href: "/dashboard/reservations", roles: ["owner", "manager", "cashier", "waiter"], flag: "reservations" },
  { label: "ارسال و پیک", href: "/dashboard/delivery", roles: ["owner", "manager", "cashier"], flag: "delivery" },
  { label: "انبار", href: "/dashboard/inventory", roles: ["owner", "manager"], flag: "inventory" },
  { label: "حسابداری", href: "/dashboard/ledger", roles: ["owner", "manager", "accountant"], flag: "ledger" },
  { label: "گزارش‌ها", href: "/dashboard/reports", roles: ["owner", "manager", "accountant"], flag: "reporting" },
  { label: "مدیریت شعب", href: "/dashboard/branches", roles: ["owner"], flag: "multi_location" },
  { label: "دستیار هوشمند", href: "/dashboard/ai", roles: ["owner", "manager"], flag: "ai_assistant" },
  { label: "تنظیمات", href: "/dashboard/settings" },
];

function canSee(item: NavItem, role: Role, permissions: Set<Permission>, features: Record<string, boolean>): boolean {
  if (item.flag && !features[item.flag]) return false;
  if (item.roles && !item.roles.includes(role)) return false;
  return !item.requiredAnyPermission || item.requiredAnyPermission.some((permission) => permissions.has(permission));
}

export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await getSession();
  if (!session) redirect("/login");

  // withTenant() rather than the ambient scope getSession() already set: that
  // scope was applied with enterWith(), which does not survive a concurrent
  // withTenant()/withoutTenantScope() run() call elsewhere in the process (a
  // background tick, another in-flight request) — see the withTenantScope
  // doc comment in src/lib/auth.ts. Without this, the query below can come
  // back empty non-deterministically and, since it gates access, incorrectly
  // sign an active member out.
  const [{ rows }, features] = await withTenant(
    session.businessId,
    () =>
      Promise.all([
        query<{ role: Role; permissions: unknown; is_active: boolean }>(
          "SELECT role, permissions, is_active FROM users WHERE id = $1 AND business_id = $2",
          [session.sub, session.businessId],
        ),
        effectiveFeatures(session.businessId),
      ]),
    { locationId: session.locationId, userId: session.sub },
  );
  const member = rows[0];
  if (!member?.is_active) redirect("/login");
  const permissions = effectivePermissions(member.role, parseOverrides(member.permissions));
  const settingsTabs = visibleSettingsTabs(permissions, { role: member.role, features });
  const navItems = NAV_ITEMS.filter((item) => canSee(item, member.role, permissions, features)).filter(
    (item) => item.href !== "/dashboard/settings" || settingsTabs.length > 0,
  );

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <DashboardSidebar navItems={navItems} role={member.role} fullName={session.fullName} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <OfflineBanner />
        <main className="flex-1 overflow-y-auto p-2 pb-24 md:p-4">{children}</main>
      </div>
      {(member.role === "owner" || member.role === "manager") && features.ai_assistant ? <AiAssistant mode="dashboard" /> : null}
    </div>
  );
}
