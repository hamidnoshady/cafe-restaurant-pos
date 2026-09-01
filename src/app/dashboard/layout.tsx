import { redirect } from "next/navigation";
import { getSession, type Role } from "@/lib/auth";
import { appForModule } from "@/lib/apps";
import { effectiveAppAvailability } from "@/lib/app-availability-service";
import { query, withTenant } from "@/lib/db";
import { effectiveFeatures, isLockableFeature } from "@/lib/features";
import { INDUSTRY_LABELS, type Industry } from "@/lib/industries";
import { hasModule, industryProfile, labelFor } from "@/lib/industry-profile";
import { effectivePermissions, parseOverrides, type Permission } from "@/lib/permissions";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { visibleSettingsTabs } from "@/lib/settings-tabs";
import { MoneyProvider } from "@/components/money/money-context";
import { BugReportProvider } from "@/components/bug-report/bug-report-provider";
import { LockProvider } from "./lock-screen";
import { DashboardSidebar, type NavItem } from "./dashboard-sidebar";
import { DashboardMain } from "./dashboard-main";
import { AppAvailabilityGate } from "./app-availability-gate";

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
    // Phase 35 Wave 2: the dashboard itself moved to /dashboard/overview; the
    // bare /dashboard route is now the chat home. Links that meant "the
    // dashboard" point here instead, so the legacy surface is still one tap away
    // whether or not the workspace shell is on.
    { label: "داشبورد", module: "dashboard", href: "/dashboard/overview" },
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
    // Phase 36b — loyalty, campaigns/gift cards and commission are one app
    // now («رشد و بازاریابی», /dashboard/growth), with its own dashboard the
    // way accounting has one. The entry is anchored on the `loyalty` module —
    // core for every trade — and the app's own main sidebar restricts its
    // sections by role (src/lib/app-shells.ts hands that sidebar over): a cashier
    // lands on loyalty, the surface the old flat page gave them, and never sees
    // commission or the KPIs. The old routes redirect.
    {
      label: "رشد و بازاریابی",
      module: "loyalty",
      href: "/dashboard/growth",
      roles: ["owner", "manager", "cashier"],
    },
    // Its own app (issue #378) — an integration with an external system of
    // record (eshobe-cms), not a Growth engine. Owner/manager only, the same
    // line the connections app draws for its own machine credentials.
    {
      label: "وب‌سایت",
      module: "website",
      href: "/dashboard/website",
      roles: ["owner", "manager"],
    },
    {
      label: "خرید و انبار",
      module: "stock",
      href: "/dashboard/stock",
      roles: ["owner", "manager"],
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
    { label: INDUSTRY_LABELS.cosmetics, module: "cosmetics", href: "/dashboard/cosmetics", roles: ["owner", "manager"] },
    { label: INDUSTRY_LABELS.wholesale, module: "wholesale", href: "/dashboard/wholesale", roles: ["owner", "manager"] },
    { label: INDUSTRY_LABELS.tools_fittings, module: "tools_fittings", href: "/dashboard/tools-fittings", roles: ["owner", "manager"] },
    { label: INDUSTRY_LABELS.haberdashery, module: "haberdashery", href: "/dashboard/haberdashery", roles: ["owner", "manager"] },
    { label: "حسابداری", module: "ledger", href: "/dashboard/ledger", roles: ["owner", "manager", "accountant"], flag: "ledger" },
    // Not flag-gated, unlike the WooCommerce page it replaced: the hub's three
    // tabs have three different entitlements and one — connecting the desktop
    // app — is not an entitlement at all, so gating the entry would hide the
    // free connection behind the paid ones. Each tab locks itself.
    { label: "اتصال‌ها", module: "integrations", href: "/dashboard/connections", roles: ["owner", "manager"] },
    { label: "گزارش‌ها", module: "reports", href: "/dashboard/reports", roles: ["owner", "manager", "accountant"], flag: "reporting" },
    { label: "دستیار هوشمند", module: "ai", href: "/dashboard/ai", roles: ["owner", "manager"], flag: "ai_assistant" },
    // Wallet/credits & plans. The small credit badge in the chrome links here
    // too; the nav entry gives owners/managers a permanent door.
    { label: "اعتبار و پرداخت‌ها", module: "settings", href: "/dashboard/billing", roles: ["owner", "manager"] },
    { label: "تنظیمات", module: "settings", href: "/dashboard/settings" },
    // Migration 0130 — the support desk. Every member may open a ticket
    // (asking for help is not a privileged act), so there is no `roles` gate;
    // the `settings` module anchors it because every industry has settings.
    // Owners and managers see the whole business queue, the rest only their
    // own tickets — enforced server-side in src/lib/support-service.ts.
    { label: "پشتیبانی", module: "settings", href: "/dashboard/support" },
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
  const [{ rows }, features, { rows: bizRows }, prefs, appAvailability] = await withTenant(
    session.businessId,
    () =>
      Promise.all([
        query<{ role: Role; permissions: unknown; is_active: boolean }>(
          "SELECT role, permissions, is_active FROM users WHERE id = $1 AND business_id = $2",
          [session.sub, session.businessId],
        ),
        effectiveFeatures(session.businessId),
        query<{ industry: Industry }>("SELECT industry FROM businesses WHERE id = $1", [session.businessId]),
        getSetting<{ currencyDisplay?: "toman" | "rial" }>(session.businessId, SETTING_KEYS.businessPrefs),
        // Migration 0128 — the app's own state («به‌زودی», «در حال تعمیر», …),
        // resolved platform row + per-business override. Orthogonal to the
        // feature flags above: a flag says whether the business is entitled to
        // a capability, this says whether the app it lives in is working.
        effectiveAppAvailability(session.businessId),
      ]),
    { locationId: session.locationId, userId: session.sub },
  );
  const member = rows[0];
  if (!member?.is_active) redirect("/login");
  const currencyDisplay = prefs?.currencyDisplay === "rial" ? "rial" : "toman";
  const industry = bizRows[0]?.industry ?? "food_service";
  const permissions = effectivePermissions(member.role, parseOverrides(member.permissions));
  const settingsTabs = visibleSettingsTabs(permissions, { role: member.role, features, industry });
  const profile = industryProfile(industry);
  const navItems = navItemsFor(industry)
    .filter((item) => canSee(item, member.role, permissions, features, industry))
    .filter((item) => item.href !== "/dashboard/settings" || settingsTabs.length > 0)
    .map((item) => {
      // An app that is off is *announced*, not hidden: the entry stays and
      // carries its state's badge («به‌زودی», «در حال تعمیر», «نسخهٔ آزمایشی»),
      // and its page renders the explanation screen instead of the app. That
      // is why this is a `map` and not another `filter` — see
      // src/lib/app-availability.ts for why the two off-switches differ.
      const app = appForModule(item.module);
      const availability = app ? appAvailability[app] : undefined;
      return {
        ...item,
        locked: Boolean(item.flag && !features[item.flag]),
        appState:
          availability && availability.badged
            ? { state: availability.state, label: availability.label, usable: availability.usable }
            : undefined,
      };
    });
  // Phase 35 Wave 2 — the workspace shell is gated on this flag. Off (the
  // default) keeps the classic sidebar; on means the workspace rail is used
  // for the chat home and projects surface.
  const workspaceEnabled = Boolean(features.workspace);

  return (
    <LockProvider fullName={session.fullName}>
      <MoneyProvider unit={currencyDisplay}>
        <BugReportProvider>
        {/*
          A *definite* height, not `min-h-screen` — this is the fix for "the app
          doesn't scroll on my phone".

          The dashboard scrolls inside <main>, which is `overflow-y-auto` and
          `overscroll-y-contain`. With `min-height` here the box still grew to
          its content, so <main> was always exactly as tall as its own content
          and never had anything to scroll: the *document* scrolled instead. On
          a desktop that is merely untidy. On a touch screen it is fatal — the
          drag is captured by <main> (a scroll container with zero scrollable
          distance) and `overscroll-behavior: contain` is precisely the rule
          that stops it chaining out to the document. Nothing moves, on every
          page, and no amount of pulling helps.

          Giving the box a definite height makes <main> the scroller it was
          always written as. `dvh` rather than `vh` so it tracks the visible
          viewport as a phone's URL bar comes and goes; `svh` would leave a gap
          once the bar retracts.
        */}
        <div className="flex h-[100dvh] flex-col md:h-screen md:flex-row">
        <DashboardSidebar
          navItems={navItems}
          role={member.role}
          fullName={session.fullName}
          brandTitle={profile.brandTitle}
          brandSubtitle={profile.brandSubtitle}
          variant={workspaceEnabled ? "workspace" : "classic"}
          industry={industry}
        />
        <DashboardMain workspaceEnabled={workspaceEnabled}>
          <AppAvailabilityGate availability={appAvailability}>{children}</AppAvailabilityGate>
        </DashboardMain>
        </div>
        </BugReportProvider>
      </MoneyProvider>
    </LockProvider>
  );
}
