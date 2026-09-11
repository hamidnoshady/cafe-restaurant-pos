import { redirect } from "next/navigation";
import { getSession, type Role } from "@/lib/auth";
import { appForModule } from "@/lib/apps";
import {
  isProductWorkspaceIndustry,
  PRODUCT_WORKSPACE_SECTIONS,
} from "@/lib/product-workspace";
import { visibleConnectionKinds, type ConnectionKind } from "@/lib/connection-kinds";
import { ACCOUNTING_ROLES, ACCOUNTING_SECTIONS } from "./accounting/accounting-nav";
import { accountingSectionHref } from "./accounting/accounting-routes";
import { REPORTS_TABS, reportsTabHref } from "./reports/reports-nav";
import { effectiveAppAvailability } from "@/lib/app-availability-service";
import { query, withTenant } from "@/lib/db";
import { effectiveFeatures, isLockableFeature } from "@/lib/features";
import { INDUSTRY_LABELS, type Industry } from "@/lib/industries";
import { hasModule, industryProfile, labelFor } from "@/lib/industry-profile";
import { effectivePermissions, parseOverrides, type Permission } from "@/lib/permissions";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { visibleSettingsTabs, type ResolvedSettingsTab } from "@/lib/settings-tabs";
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
interface NavContext {
  /** The settings tabs this member may open (already role/permission/feature-filtered). */
  settingsTabs: ResolvedSettingsTab[];
  /** The connection kinds this member may open (already role/module-filtered). */
  connectionKinds: ConnectionKind[];
}

function navItemsFor(industry: Industry, ctx: NavContext): NavItem[] {
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
    // The CRM app's door (Phase 36 — it is its own app, not a section of any
    // other). It is anchored on the `customers` module — core for every trade,
    // so a business that has customers has a CRM — and points at the app's own
    // home (`/crm/overview`), the same way «رشد و بازاریابی» points at
    // `/growth/overview` and «مدیریت وب‌سایت» at `/websites/overview`. The old
    // flat href `/dashboard/customers` is kept only as a redirect page for
    // saved bookmarks; using it here made two things go wrong at once:
    //   1. the workspace rail's CRM launcher (which looks for `/crm/overview`)
    //      never matched, so «ارتباط با مشتری» was missing from the rail's
    //      «برنامه‌ها» list while Growth and the Website app were present; and
    //   2. because the href was not inside any app shell prefix, the entry was
    //      not filtered out of the flat business nav in the workspace shell, so
    //      it kept surfacing (as «مشتریان», redirecting into the CRM directory)
    //      while the member was inside another app such as حسابداری — the CRM
    //      leaking into Accounting instead of Accounting keeping its own
    //      «اشخاص»/«مشتریان» sections.
    // The accountant is deliberately not here: the CRM app does not admit them
    // (see `canOpenCrm`); they manage the shared customer record from
    // Accounting's own «اشخاص» and «مشتریان» sections, and `/dashboard/customers`
    // still redirects an accountant there for any old bookmark.
    {
      label: "ارتباط با مشتری",
      module: "customers",
      href: "/crm/overview",
      roles: ["owner", "manager", "cashier"],
    },
    // Phase 36b — loyalty, campaigns/gift cards and commission are one app
    // now («رشد و بازاریابی», /growth), with its own dashboard the
    // way accounting has one. The entry is anchored on the `loyalty` module —
    // core for every trade — and the app's own main sidebar restricts its
    // sections by role (src/lib/app-shells.ts hands that sidebar over): a cashier
    // lands on loyalty, the surface the old flat page gave them, and never sees
    // commission or the KPIs. The old routes redirect.
    {
      label: "رشد و بازاریابی",
      module: "loyalty",
      href: "/growth/overview",
      roles: ["owner", "manager", "cashier"],
    },
    // Its own app (issue #378) — an integration with an external system of
    // record (eshobe-cms), not a Growth engine. Owner/manager only, the same
    // line the connections app draws for its own machine credentials.
    {
      label: "وب‌سایت",
      module: "website",
      href: "/websites/overview",
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
    // Phase 42 — the retail trade-goods trades manage their catalogue in the
    // shared products workspace: a collapsible sidebar group — افزودن محصول،
    // لیست محصولات، لیست قیمت، ویژگی محصول، الگوی بارکد وزنی and the trade's
    // own گزارش‌ها — instead of five flat trade entries. The old trade pages
    // forward into the workspace; cosmetics alone keeps its own entry for the
    // sections only it has (بچ‌ها و انقضا، برند و ماتریس).
    ...(isProductWorkspaceIndustry(industry)
      ? [
          {
            label: "محصولات",
            module: industry,
            iconKey: "/dashboard/products",
            roles: ["owner", "manager"],
            children: PRODUCT_WORKSPACE_SECTIONS.map((section) => ({
              label: section.label,
              module: industry,
              href: section.href,
              roles: ["owner", "manager"],
            })),
          },
        ]
      : []),
    ...(industry === "cosmetics"
      ? [{ label: INDUSTRY_LABELS.cosmetics, module: "cosmetics" as const, href: "/dashboard/cosmetics", roles: ["owner", "manager"] }]
      : []),
    // The «حسابداری» sub-menu — the Accounting app's sections, each a real
    // route under the app's own prefix (`/accounting/…`), drawn as a
    // collapsible sidebar group (the same shape «محصولات» uses) with the app's
    // dashboard as its first entry. The parent keeps its href so the section is
    // still one tap away and still pinnable to the bottom bar; the app's old
    // `/dashboard/ledger?tab=…` addresses forward to these routes.
    {
      label: "حسابداری",
      module: "ledger",
      href: "/accounting/overview",
      roles: [...ACCOUNTING_ROLES],
      flag: "ledger",
      children: ACCOUNTING_SECTIONS.map((section) => ({
        label: section.label,
        module: "ledger" as const,
        href: accountingSectionHref(section.key),
        roles: [...(section.roles ?? ACCOUNTING_ROLES)],
      })),
    },
    // The «اتصال‌های فنی» hub — every technical connection in the product
    // (desktop, WordPress/WooCommerce, the CMS site, Holoo, the remote server
    // sync, MCP, API keys). A shell utility, not an app: its module is
    // unassigned in `apps.ts`, so it is never badged and never gated.
    // WordPress/WooCommerce *management* is not listed here either: it lives
    // inside «مدیریت وب‌سایت» above, and the old `/dashboard/wp` prefix
    // forwards there (its connection screen forwards to this hub instead), so
    // one door stays one door.
    {
      label: "اتصال‌های فنی",
      module: "connections",
      href: "/dashboard/connections",
      roles: ["owner", "manager"],
      children: ctx.connectionKinds.map((kind) => ({
        label: kind.label,
        module: "connections" as const,
        href: `/dashboard/connections?tab=${kind.key}`,
      })),
    },
    {
      label: "گزارش‌ها",
      module: "reports",
      href: "/dashboard/reports",
      roles: ["owner", "manager", "accountant"],
      flag: "reporting",
      children: REPORTS_TABS.map((tab) => ({
        label: tab.label,
        module: "reports" as const,
        href: reportsTabHref(tab.key),
        roles: tab.roles ?? ["owner", "manager", "accountant"],
      })),
    },
    { label: "دستیار هوشمند", module: "ai", href: "/dashboard/ai", roles: ["owner", "manager"], flag: "ai_assistant" },
    // Wallet/credits & plans. The small credit badge in the chrome links here
    // too; the nav entry gives owners/managers a permanent door.
    { label: "اعتبار و پرداخت‌ها", module: "settings", href: "/settings", roles: ["owner", "manager"] },
    // Settings tabs are already role/permission/feature-filtered server-side
    // (`visibleSettingsTabs`), so they carry no further gate here.
    {
      label: "تنظیمات",
      module: "settings",
      href: "/settings",
      children: ctx.settingsTabs.map((tab) => ({
        label: tab.label,
        module: "settings" as const,
        href: `/settings?tab=${tab.key}`,
      })),
    },
    // Migration 0131 — the in-product knowledge base («مرکز آموزش»): every
    // member learns the platform here, so like the support desk it has no
    // role gate; the `settings` module anchors it because every trade has it.
    { label: "مرکز آموزش", module: "settings", href: "/dashboard/knowledge" },
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
  const connectionKinds = visibleConnectionKinds({ role: member.role, industry });
  const profile = industryProfile(industry);
  const navItems = navItemsFor(industry, { settingsTabs, connectionKinds })
    // Phase 42 — group children go through the same role/module/permission
    // gate as their parent; a group whose children all filtered out is gone
    // rather than an empty disclosure.
    .map((item) =>
      item.children
        ? { ...item, children: item.children.filter((child) => canSee(child, member.role, permissions, features, industry)) }
        : item,
    )
    .filter((item) => !item.children || item.children.length > 0)
    .filter((item) => canSee(item, member.role, permissions, features, industry))
    .filter((item) => item.href !== "/settings" || settingsTabs.length > 0)
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
          <AppAvailabilityGate availability={appAvailability} workspaceEnabled={workspaceEnabled}>
            {children}
          </AppAvailabilityGate>
        </DashboardMain>
        </div>
        </BugReportProvider>
      </MoneyProvider>
    </LockProvider>
  );
}
