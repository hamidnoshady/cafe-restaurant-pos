import { redirect } from "next/navigation";
import { getSession, type Role } from "@/lib/auth";
import { query, withTenant } from "@/lib/db";
import { effectiveFeatures, isLockableFeature } from "@/lib/features";
import { INDUSTRY_LABELS, type Industry } from "@/lib/industries";
import { hasModule, industryProfile, labelFor } from "@/lib/industry-profile";
import { effectivePermissions, parseOverrides, PERMISSIONS, type Permission } from "@/lib/permissions";
import { visibleSettingsTabs } from "@/lib/settings-tabs";
import { AiAssistant } from "@/components/ai/ai-assistant";
import { LockProvider } from "./lock-screen";
import { OfflineBanner } from "./offline-banner";
import { DashboardSidebar, type NavItem } from "./dashboard-sidebar";

/**
 * The dashboard nav.
 *
 * Each entry names the `module` that owns it (src/lib/industry-profile.ts), so
 * which entries exist is a property of the business's industry rather than of
 * this list. Labels that differ by trade come from `labelFor` for the same
 * reason — a jewellery business's sell screen is «فروش و فاکتور», not
 * «صندوق (فروش)» — while labels that are the same everywhere stay literals.
 *
 * The three industry pages take their label from `INDUSTRY_LABELS`, the same
 * constant the console and the /welcome picker use, so a business's type is
 * called one thing across the whole product.
 */
function navItemsFor(industry: Industry): NavItem[] {
  return [
    { label: "داشبورد", module: "dashboard", href: "/dashboard" },
    {
      label: labelFor(industry, "saleDocumentPlural"),
      module: "orders",
      href: "/dashboard/orders",
      roles: ["owner", "manager", "cashier", "waiter"],
    },
    {
      label: labelFor(industry, "sellScreen"),
      module: "pos",
      href: "/dashboard/pos",
      roles: ["owner", "manager", "cashier"],
    },
    {
      label: "مشتریان",
      module: "customers",
      href: "/dashboard/customers",
      roles: ["owner", "manager", "cashier", "accountant"],
    },
    { label: "میزها", module: "tables", href: "/dashboard/floor", roles: ["owner", "manager", "cashier", "waiter"], flag: "reservations" },
    { label: "میزهای من", module: "waiter", href: "/dashboard/waiter", roles: ["cashier", "waiter"], flag: "reservations" },
    { label: "آشپزخانه", module: "kitchen", href: "/dashboard/kitchen", roles: ["owner", "manager", "kitchen"] },
    { label: "رزروها", module: "reservations", href: "/dashboard/reservations", roles: ["owner", "manager", "cashier", "waiter"], flag: "reservations" },
    { label: "ارسال و پیک", module: "delivery", href: "/dashboard/delivery", roles: ["owner", "manager", "cashier"], flag: "delivery" },
    { label: "انبار", module: "inventory", href: "/dashboard/inventory", roles: ["owner", "manager"], flag: "inventory" },
    { label: INDUSTRY_LABELS.jewelry, module: "jewelry", href: "/dashboard/jewelry", roles: ["owner", "manager"] },
    { label: INDUSTRY_LABELS.watch, module: "watch", href: "/dashboard/watch", roles: ["owner", "manager"] },
    { label: INDUSTRY_LABELS.accessories, module: "accessories", href: "/dashboard/accessories", roles: ["owner", "manager"] },
    { label: "حسابداری", module: "ledger", href: "/dashboard/ledger", roles: ["owner", "manager", "accountant"], flag: "ledger" },
    // Not flag-gated, unlike the WooCommerce page it replaced: the hub's three
    // tabs have three different entitlements and one — connecting the desktop
    // app — is not an entitlement at all, so gating the entry would hide the
    // free connection behind the paid ones. Each tab locks itself.
    { label: "اتصال‌ها", module: "integrations", href: "/dashboard/connections", roles: ["owner", "manager"] },
    { label: "گزارش‌ها", module: "reports", href: "/dashboard/reports", roles: ["owner", "manager", "accountant"], flag: "reporting" },
    { label: "دستیار هوشمند", module: "ai", href: "/dashboard/ai", roles: ["owner", "manager"], flag: "ai_assistant" },
    { label: "تنظیمات", module: "settings", href: "/dashboard/settings" },
  ];
}

function canSee(
  item: NavItem,
  role: Role,
  permissions: Set<Permission>,
  features: Record<string, boolean>,
  industry: Industry,
): boolean {
  // Industry first: a module this trade does not have is not merely switched
  // off, it does not exist here, and its route refuses too (auth.ts).
  if (!hasModule(industry, item.module)) return false;
  // A disabled flag hides its entry — unless the feature is lockable, in which
  // case the entry stays and is marked with a padlock instead (see
  // LOCKABLE_FEATURES in features.ts). Its page renders a read-only preview
  // rather than redirecting, so the link goes somewhere real either way.
  if (item.flag && !features[item.flag] && !isLockableFeature(item.flag)) return false;
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
  const [{ rows }, features, { rows: bizRows }] = await withTenant(
    session.businessId,
    () =>
      Promise.all([
        query<{ role: Role; permissions: unknown; is_active: boolean }>(
          "SELECT role, permissions, is_active FROM users WHERE id = $1 AND business_id = $2",
          [session.sub, session.businessId],
        ),
        effectiveFeatures(session.businessId),
        query<{ industry: Industry }>("SELECT industry FROM businesses WHERE id = $1", [session.businessId]),
      ]),
    { locationId: session.locationId, userId: session.sub },
  );
  const member = rows[0];
  if (!member?.is_active) redirect("/login");
  const industry = bizRows[0]?.industry ?? "food_service";
  const permissions = effectivePermissions(member.role, parseOverrides(member.permissions));
  const settingsTabs = visibleSettingsTabs(permissions, { role: member.role, features, industry });
  const profile = industryProfile(industry);
  const navItems = navItemsFor(industry)
    .filter((item) => canSee(item, member.role, permissions, features, industry))
    .filter((item) => item.href !== "/dashboard/settings" || settingsTabs.length > 0)
    .map((item) => ({ ...item, locked: Boolean(item.flag && !features[item.flag]) }));
  const assistantMode =
    member.role === "cashier" || member.role === "waiter"
      ? "floor"
      : member.role === "owner" || member.role === "manager"
        ? "dashboard"
        : null;
  const canUseAssistant =
    assistantMode === "dashboard" ||
    (assistantMode === "floor" && permissions.has(PERMISSIONS.menuView));

  return (
    <LockProvider fullName={session.fullName}>
      <div className="flex min-h-screen flex-col md:flex-row">
        <DashboardSidebar
          navItems={navItems}
          role={member.role}
          fullName={session.fullName}
          brandTitle={profile.brandTitle}
          brandSubtitle={profile.brandSubtitle}
        />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <OfflineBanner />
          <main className="flex-1 overflow-y-auto p-2 pb-24 md:p-4">{children}</main>
        </div>
        {assistantMode && canUseAssistant && features.ai_assistant ? <AiAssistant mode={assistantMode} /> : null}
      </div>
    </LockProvider>
  );
}
