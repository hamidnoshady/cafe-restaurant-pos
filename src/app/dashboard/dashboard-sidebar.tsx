"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams, type ReadonlyURLSearchParams } from "next/navigation";
import {
  ArmchairIcon,
  BarChart3Icon,
  BookOpenIcon,
  BotIcon,
  CalendarDaysIcon,
  CalculatorIcon,
  CheckIcon,
  ChefHatIcon,
  ChevronDownIcon,
  CircleIcon,
  ClipboardListIcon,
  ContactIcon,
  FolderIcon,
  GemIcon,
  GlobeIcon,
  LayoutDashboardIcon,
  LayoutGridIcon,
  LifeBuoyIcon,
  LockIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  PackageIcon,
  PlugIcon,
  SettingsIcon,
  ShoppingCartIcon,
  SparklesIcon,
  TrendingUpIcon,
  TruckIcon,
  UsersIcon,
  WalletIcon,
  WatchIcon,
  type LucideIcon,
} from "lucide-react";
import {
  BOTTOM_NAV_MAX,
  BOTTOM_NAV_STORAGE_KEY,
  parseBottomNavHrefs,
  resolveBottomNavHrefs,
  toggleBottomNavHref,
} from "@/lib/bottom-nav";
import type { Industry } from "@/lib/industries";
import {
  resolveSidebarMode,
  toggleDashboardSidebarPreference,
  type DashboardSidebarPreference,
} from "@/lib/sidebar-state";
import { isAssistantSurface } from "@/lib/assistant-route";
import { ACCOUNTING_WORKSPACE_HREFS } from "@/lib/app-routes";
import { bestNavMatch, flattenNav } from "@/lib/nav-tree";
import { appForModule, isAppKey, type AppKey } from "@/lib/apps";
import type { AppAvailabilityState } from "@/lib/app-availability";
import { appShellForPathname, isInsideAnyAppShell, type AppShellDef } from "@/lib/app-shells";
import { ACCOUNTING_SECTION_ICONS } from "@/app/(app)/accounting/accounting-icons";
import { isAccountingSectionPathname } from "@/app/(app)/accounting/accounting-routes";
import {
  accountingWorkspaceGroups,
  LEDGER_WORKSPACE_GROUP_KEY,
  type WorkspaceNavEntry,
  type WorkspaceNavGroup,
} from "@/app/(app)/accounting/accounting-workspace";
import { AppStateBadge } from "./app-availability-gate";
import { CreditBadge } from "./credit-badge";
import { popoverPanelClass } from "./page-chrome";
import { NAV_ICONS } from "./sidebar-nav-icons";
import {
  APP_NAV_BUTTON_CLASS,
  BACK_TO_WORKSPACE_BUTTON_CLASS,
  NAV_LABEL_CLASS,
  SIDEBAR_FOOTER_BUTTON_CLASS,
} from "./sidebar-nav-styles";
import { appShellNavFor, type AppShellNavProps } from "./app-shell-nav";
import { NavCollapsibleGroup, NavGroup } from "./sidebar-nav-group";
import type { ModuleKey } from "@/lib/industry-profile";
import type { Permission } from "@/lib/permissions";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ThemeToggle } from "@/components/theme-toggle";
import { BugReportFooterButton } from "@/components/bug-report/report-buttons";
import { BiometricSettingsButton } from "./biometric-settings";
import { BranchSwitcher } from "./branch-switcher";
import { LockButton } from "./lock-screen";
import { LogoutButton } from "./logout-button";
import { PlatformUserMenu } from "./platform-user-menu";
import { ShiftButton } from "./shift-panel";
import { AiRecentConversations } from "./ai/ai-recent-conversations";

/** Roles that sign in with a PIN (team.ts's PIN_ROLES) — the lock screen is a floor-terminal convenience for them. */
const PIN_ROLES = ["cashier", "waiter", "kitchen"];

const SIDEBAR_PREFERENCE_KEY = "dashboard-sidebar-preference";

/**
 * Resizable sidebar width. The rail starts at the same width the fixed shell
 * always used (w-64 = 16rem), and drag/arrow keys move it between the bounds;
 * the choice is remembered per device.
 */
const SIDEBAR_WIDTH_KEY = "dashboard-sidebar-width";
const SIDEBAR_DEFAULT_WIDTH = 256;
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 460;
const SIDEBAR_KEYBOARD_STEP = 16;


/**
 * The apps the workspace rail launches, in rail order — plus the one hub.
 *
 * A table rather than a block of markup per app: the rail is the front door to
 * every app in the platform, so adding one (the CRM, and whatever follows it)
 * should be an entry here, not another copy of a `SidebarMenuItem`.
 *
 * `hrefs` is a preference list, not an alias list. The first entry is the app's
 * own home; the rest are pages the app absorbed, kept so that a member whose
 * saved bottom-nav or bookmark still points at an old flat route is launched
 * into the app instead of hitting a redirect chain. Only routes the member can
 * actually reach (their trade's modules, their role, their feature flags — the
 * nav list is already filtered for all three) are considered, which is what
 * makes an app disappear from the rail for a business that does not have it.
 *
 * The last entry is not an app: «اتصال‌های فنی» is the shell's technical hub
 * (src/lib/apps.ts), launched from the rail like an app but never badged and
 * never gated.
 */
const WORKSPACE_APP_LAUNCHERS: readonly {
  key: AppKey | "connections";
  label: string;
  icon: LucideIcon;
  hrefs: readonly string[];
}[] = [
  {
    key: "accounting",
    label: "حسابداری",
    icon: CalculatorIcon,
    // The app's own pages first: opening «حسابداری» lands on the app's home
    // (`/accounting`), not on the sales overview. The overview is
    // only the fallback for a member whose role cannot open the accounting
    // pages or the reports at all; the old `/dashboard/ledger` address stays
    // as a preference-list entry for any surface still holding it.
    hrefs: ["/accounting/overview", "/accounting/financial-reports", "/accounting/reports", "/overview"],
  },
  {
    key: "crm",
    label: "ارتباط با مشتری",
    icon: ContactIcon,
    // `/crm/directory` redirects into the app's directory, so a business
    // that has customers but has never opened the CRM still gets the launcher.
    hrefs: ["/crm/overview", "/crm/directory"],
  },
  {
    key: "growth",
    label: "رشد و بازاریابی",
    icon: TrendingUpIcon,
    hrefs: [
      "/growth/overview",
      "/growth/loyalty",
      "/growth/campaigns",
      "/growth/commission",
    ],
  },
  {
    key: "website",
    label: "مدیریت وب‌سایت",
    icon: GlobeIcon,
    // One launcher for both managers, opening the app home. (The old
    // `/dashboard/wp` prefix still forwards into the app for bookmarks and
    // saved bottom-nav slots, but it is not a nav entry anymore, so it is not
    // a launcher fallback either.) Do not fall back to the technical
    // connection hub: that would put the site managers back behind the
    // Accounting/Connections door.
    hrefs: ["/websites/overview"],
  },
  {
    key: "connections",
    label: "اتصال‌های فنی",
    icon: PlugIcon,
    hrefs: ["/settings/connections"],
  },
];

export interface NavItem {
  label: string;
  /** The industry module that owns this entry (src/lib/industry-profile.ts); already filtered out of navItems for an industry that has no such module. */
  module: ModuleKey;
  href?: string;
  /**
   * Phase 42 — a collapsible group («محصولات») rather than a link: the button
   * discloses `children` beneath it. The `iconKey` names the NAV_ICONS entry
   * the group wears, since a group has no href of its own to derive one from.
   */
  children?: NavItem[];
  iconKey?: string;
  roles?: string[];
  /** Set when this page is gated by a Phase 17 feature flag; already filtered out of navItems if disabled and not lockable. */
  flag?: string;
  /**
   * The flag is off but the feature is lockable (features.ts's
   * LOCKABLE_FEATURES), so the entry stays in the nav and its page renders a
   * read-only preview. Server-computed; the padlock here only labels it.
   */
  locked?: boolean;
  /**
   * The state of the *app* this entry belongs to, when it is anything other
   * than plain «فعال» (migration 0128 / src/lib/app-availability.ts). Present
   * only for a badged state, so rendering is `appState ? <badge> : null`.
   * `usable: false` means the link goes to the explanation screen rather than
   * the app — the entry is deliberately still here, because "coming soon" is
   * news the business should have rather than an absence they should guess at.
   */
  appState?: { state: AppAvailabilityState; label: string; usable: boolean };
  /** Server-filtered against the member's effective permission set before reaching the client. */
  requiredAnyPermission?: Permission[];
}

interface SidebarProps {
  navItems: NavItem[];
  role: string;
  fullName: string;
  /** From the business's industry profile — a jewellery shop is not «کافه و رستوران». */
  brandTitle: string;
  brandSubtitle: string;
  /**
   * Phase 35 Wave 2 — which shell the business is entitled to. `"workspace"`
   * shows the rail (New chat / Projects / apps / recent threads) on the chat
   * home and the projects surface; everywhere else the shell falls back to the
   * classic flat sidebar, so entering an app feels like the main product the
   * business already knows. `"classic"` is the flat nav, unchanged.
   */
  variant?: "classic" | "workspace";
  /** The business's industry. */
  industry?: Industry;
}

/**
 * Whether a nav href is the current location.
 *
 * A bare href (no `?`) is a section's home and is active on its whole path
 * prefix, the way the flat nav always behaved — so a group's parent link stays
 * lit on every one of its query-string tabs. A `?tab=` href is a *named* sub-
 * section: it matches only that tab (other query params, like a `party=` deep
 * link, are ignored so the «مشتریان» entry stays lit on one customer's file).
 */
function isActive(pathname: string, href: string, search?: ReadonlyURLSearchParams | null): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  const q = href.indexOf("?");
  if (q >= 0) {
    const hrefPath = href.slice(0, q);
    if (pathname !== hrefPath) return false;
    const hrefTab = new URLSearchParams(href.slice(q + 1)).get("tab");
    return (search?.get("tab") ?? null) === hrefTab;
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Which collapsible nav groups the member left open, per device. */
const OPEN_NAV_GROUPS_KEY = "dashboard-sidebar-open-groups";

function entryIsActive(entry: WorkspaceNavEntry, pathname: string, search: string): boolean {
  if (entry.section) {
    if (!isAccountingSectionPathname(pathname, entry.section)) return false;
    const view = new URLSearchParams(entry.href.split("?")[1] ?? "").get("view");
    const current = new URLSearchParams(search).get("view");
    return view ? current === view : !current;
  }
  const [base, query] = entry.href.split("?");
  if (query) {
    if (pathname !== base) return false;
    const expectedTab = new URLSearchParams(query).get("tab");
    if (expectedTab) {
      const actualTab = new URLSearchParams(search).get("tab");
      return actualTab === expectedTab;
    }
    return true;
  }
  if (base === "/settings") {
    return (
      pathname === "/settings" ||
      (pathname.startsWith("/settings/") &&
        !pathname.startsWith("/settings/connections") &&
        !pathname.startsWith("/settings/billing"))
    );
  }
  if (base === ACCOUNTING_WORKSPACE_HREFS.products) {
    return pathname === ACCOUNTING_WORKSPACE_HREFS.products;
  }
  if (base === "/dashboard") return pathname === "/dashboard";
  return pathname === base || pathname.startsWith(`${base}/`);
}

function SidebarNavigation({
  navItems,
  role,
  pathname,
  showWorkspaceHome = false,
}: {
  navItems: NavItem[];
  role: string;
  pathname: string;
  showWorkspaceHome?: boolean;
}) {
  const { setOpenMobile } = useSidebar();
  const search = useSearchParams();
  const searchStr = search?.toString() ?? "";
  const groups = accountingWorkspaceGroups({ role, navItems: flattenNav(navItems) });

  const inLedger = groups
    .find((group) => group.key === LEDGER_WORKSPACE_GROUP_KEY)
    ?.entries.some((entry) => entryIsActive(entry, pathname, searchStr));
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(OPEN_NAV_GROUPS_KEY);
      if (raw) setOpenGroups(JSON.parse(raw) as Record<string, boolean>);
    } catch {
      // Storage read fallback
    }
    setRestored(true);
  }, []);

  const toggleGroup = useCallback((key: string, currentlyOpen: boolean) => {
    setOpenGroups((current) => {
      const next = { ...current, [key]: !currentlyOpen };
      try {
        window.localStorage.setItem(OPEN_NAV_GROUPS_KEY, JSON.stringify(next));
      } catch {
        // Storage write fallback
      }
      return next;
    });
  }, []);

  const onNavigate = useCallback(() => setOpenMobile(false), [setOpenMobile]);

  return (
    <SidebarContent className="px-3 py-4">
      <nav aria-label="ناوبری اصلی" className="space-y-3">
        {showWorkspaceHome ? (
          <>
            <SidebarMenu className="space-y-1.5">
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={pathname === "/dashboard"}
                  tooltip="بازگشت به میز کار"
                  className={BACK_TO_WORKSPACE_BUTTON_CLASS}
                >
                  <Link href="/dashboard" onClick={onNavigate} aria-current={pathname === "/dashboard" ? "page" : undefined}>
                    <LayoutGridIcon aria-hidden="true" className="size-5 shrink-0" />
                    <span className={NAV_LABEL_CLASS}>بازگشت به میز کار</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
            <div aria-hidden="true" className="border-t border-border/80" />
          </>
        ) : null}

        {groups.map((group) => {
          if (group.entries.length === 0) return null;
          const isActive = (entry: WorkspaceNavEntry) => entryIsActive(entry, pathname, searchStr);

          if (group.collapsible) {
            const open = restored ? (openGroups[group.key] ?? Boolean(inLedger)) : Boolean(inLedger);
            return (
              <NavCollapsibleGroup
                key={group.key}
                group={group}
                idPrefix="dashboard-nav"
                isActive={isActive}
                onNavigate={onNavigate}
                open={open}
                onToggle={() => toggleGroup(group.key, open)}
              />
            );
          }

          return <NavGroup key={group.key} group={group} isActive={isActive} onNavigate={onNavigate} />;
        })}
      </nav>
    </SidebarContent>
  );
}

/**
 * The workspace rail (Phase 35 Wave 2).
 *
 * Every entry is the same flat button — «گفت‌وگوی جدید», «پروژه‌ها», and the
 * two apps the business works in: «حسابداری» (which owns the day-to-day
 * surfaces: فروش, عملیات, اتصال‌ها and تنظیمات live behind its classic
 * sidebar) and «رشد و بازاریابی» (وفاداری، کمپین‌ها و پورسانت). No dropdowns,
 * no counts. Clicking an app opens the main product — the page plus the
 * classic sidebar — so the rail is a launcher, not a second navigation
 * system. Recent threads start short, collapse, and load more on demand.
 */
function WorkspaceRail({ navItems, pathname }: { navItems: NavItem[]; pathname: string }) {
  const router = useRouter();
  const { expandSidebar } = useSidebar();
  const hrefs = navItems.flatMap((item) => (item.href ? [item.href] : []));
  // The apps this rail launches, as data rather than three copies of the same
  // markup. Each entry lists its candidate routes in preference order: a
  // launcher always opens the app's own home, and falls back to a page the
  // app absorbed so a member whose saved bottom-nav still holds an old flat
  // route lands in the app rather than on a 404. An app with no reachable
  // route (its modules are not this trade's) is simply not listed.
  // An app's state («به‌زودی», «در حال تعمیر», …) travels on the nav entries the
  // layout already resolved — grouped here by *owning app*, so each launcher
  // wears its own app's badge, exactly what the flat sidebar shows for the
  // same app, rather than re-deriving it. Looking the state up by the
  // launcher's resolved href instead is what once badged «حسابداری» with the
  // *sales* app's «به‌زودی»: the launcher opened the sales overview, which is
  // a sales page, not an accounting one. The hub entry has no app and so is
  // never badged.
  const stateByApp = new Map<AppKey, NonNullable<NavItem["appState"]>>();
  for (const item of navItems) {
    if (!item.appState) continue;
    const owner = appForModule(item.module);
    if (owner && !stateByApp.has(owner)) stateByApp.set(owner, item.appState);
  }
  const launchers = WORKSPACE_APP_LAUNCHERS.flatMap((launcher) => {
    const href = launcher.hrefs.find((candidate) => hrefs.includes(candidate));
    if (!href) return [];
    return [
      {
        ...launcher,
        href,
        active: isActive(pathname, href),
        appState: isAppKey(launcher.key) ? stateByApp.get(launcher.key) : undefined,
      },
    ];
  });

  return (
    <SidebarContent className="px-3 py-4">
      <nav aria-label="میز کار" className="space-y-4">
        <SidebarMenu className="space-y-1.5">
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={pathname === "/dashboard"}
              tooltip="گفت‌وگوی جدید"
              className={APP_NAV_BUTTON_CLASS}
            >
              <Link href="/dashboard">
                <MessageSquarePlusIcon aria-hidden="true" className="size-5 shrink-0" />
                <span className={NAV_LABEL_CLASS}>گفت‌وگوی جدید</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={pathname.startsWith("/projects")}
              tooltip="پروژه‌ها"
              className={APP_NAV_BUTTON_CLASS}
            >
              <Link href="/projects">
                <FolderIcon aria-hidden="true" className="size-5 shrink-0" />
                <span className={NAV_LABEL_CLASS}>پروژه‌ها</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>

        {launchers.length > 0 ? (
          <div role="group" aria-labelledby="workspace-apps-heading">
            <p
              id="workspace-apps-heading"
              className="px-2 pb-1 text-xs font-medium text-muted-foreground group-data-[state=collapsed]/sidebar:hidden"
            >
              برنامه‌ها
            </p>
            {/* Collapsed to icons the heading is gone, so the apps would run
                into «پروژه‌ها» as one undifferentiated column of glyphs. A
                hairline keeps the two groups apart at 4rem wide. */}
            <div
              aria-hidden="true"
              className="mx-2 mb-2 hidden border-t border-border/70 group-data-[state=collapsed]/sidebar:block"
            />
            <SidebarMenu className="space-y-1.5">
              {launchers.map((launcher) => {
                const Icon = launcher.icon;
                return (
                  <SidebarMenuItem key={launcher.key}>
                    <SidebarMenuButton
                      asChild
                      isActive={launcher.active}
                      tooltip={
                        launcher.appState ? `${launcher.label} — ${launcher.appState.label}` : launcher.label
                      }
                      className={APP_NAV_BUTTON_CLASS}
                    >
                      <Link href={launcher.href} aria-current={launcher.active ? "page" : undefined}>
                        <Icon aria-hidden="true" className="size-5 shrink-0" />
                        <span className={NAV_LABEL_CLASS}>{launcher.label}</span>
                        {launcher.appState ? (
                          <AppStateBadge
                            state={launcher.appState.state}
                            label={launcher.appState.label}
                            className="shrink-0 group-data-[state=collapsed]/sidebar:hidden"
                          />
                        ) : null}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </div>
        ) : null}

        <div className="group-data-[state=collapsed]/sidebar:hidden">
          {/* AiRecentConversations already filters to dashboard-mode threads and
              shows its own empty/loading states; selecting one opens it in the
              chat home. It starts with five threads, collapses, and grows on
              demand so it never owns the sidebar. */}
          <AiRecentConversations
            activeId={null}
            refreshKey={0}
            initialLimit={5}
            collapsible
            onSelect={(id) => router.push(`/dashboard?conversation=${id}`)}
          />
        </div>

        {/* Collapsed, the thread list has no room to render — but it must not
            silently disappear either, or the rail looks like a business that
            has never had a conversation. One glyph stands in for it and widens
            the rail back out. */}
        <SidebarMenu className="hidden group-data-[state=collapsed]/sidebar:block">
          <SidebarMenuItem>
            <SidebarMenuButton
              type="button"
              tooltip="نخ‌های اخیر"
              aria-label="نمایش نخ‌های اخیر"
              className={APP_NAV_BUTTON_CLASS}
              onClick={expandSidebar}
            >
              <MessageSquareIcon aria-hidden="true" className="size-5 shrink-0" />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </nav>
    </SidebarContent>
  );
}

function SidebarBrand({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <SidebarHeader className="border-border/80 bg-card p-4 group-data-[state=collapsed]/sidebar:px-2">
      {/*
        Two layouts, not one squeezed layout. Expanded: the business name and
        its trade beside the controls. Collapsed: a single centred column, so
        the credit pill and the reopen control stack instead of fighting over
        4rem of width — the old row centred the whole flex line and the trigger
        drifted off the rail's centre.
      */}
      <div className="flex items-start justify-between gap-2 group-data-[state=collapsed]/sidebar:flex-col group-data-[state=collapsed]/sidebar:items-center group-data-[state=collapsed]/sidebar:gap-2">
        <div className="min-w-0 group-data-[state=collapsed]/sidebar:hidden">
          <p className="truncate font-bold text-foreground" title={title}>
            {title}
          </p>
          <p className="truncate text-xs text-muted-foreground" title={subtitle}>
            {subtitle}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1 group-data-[state=collapsed]/sidebar:flex-col">
          <span className="hidden md:block group-data-[state=collapsed]/sidebar:hidden"><CreditBadge /></span>
          <span className="hidden group-data-[state=collapsed]/sidebar:md:block"><CreditBadge compact /></span>
          {/* The theme switch used to vanish with the labels; it is an icon
              button already, so there is no reason it cannot stay on the rail. */}
          <span className="hidden md:block"><ThemeToggle /></span>
          <SidebarTrigger className="hidden text-muted-foreground md:inline-flex" />
        </div>
      </div>
      {/*
        The branch control sits here, directly under the business name, rather
        than at the bottom of the rail where it used to live among the
        sign-out/lock/shift buttons. Which branch you are working in is
        context for everything on screen — the same class of information as
        *which business* — not an account action, and at the foot of a long
        scrolling rail it was both hard to find and easy to never notice.
        Colour-coded, so the answer arrives before it is read (see
        branch-switcher.tsx).

        Hidden when the rail is collapsed to icons: the trigger needs its name
        to be useful, and the branch colour still shows on the mobile header
        and on the POS/overview page headers.
      */}
      <div className="mt-3 group-data-[state=collapsed]/sidebar:hidden">
        <BranchSwitcher compact />
      </div>
    </SidebarHeader>
  );
}

/**
 * Chooses which pages the mobile bottom bar shows.
 *
 * Lives in the drawer footer next to the other per-device switches (theme, the
 * biometric opt-in) — the same drawer the header's hamburger opens, so the
 * setting sits one tap from the thing it changes. Mobile-only, since the bar
 * itself is.
 */
function BottomNavSettings({
  navItems,
  current,
  onSave,
}: {
  navItems: NavItem[];
  current: string[];
  onSave: (hrefs: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>(current);
  // Sub-sections count too: a member who lives in «لیست قیمت» could not pin it
  // before, because the picker only ever read the nav's top level.
  const options = flattenNav(navItems);
  const full = draft.length >= BOTTOM_NAV_MAX;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Reopening always starts from what is on screen, so cancelling by
        // tapping away discards the draft rather than half-keeping it.
        if (next) setDraft(current);
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <button type="button" className={`${SIDEBAR_FOOTER_BUTTON_CLASS} mb-2 md:hidden`}>
          <LayoutGridIcon aria-hidden="true" className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-start">چیدمان نوار پایین</span>
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[80svh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>نوار پایین صفحه</DialogTitle>
          <DialogDescription>
            تا {toPersianDigits(BOTTOM_NAV_MAX)} صفحه انتخاب کنید. انتخاب‌شده:{" "}
            {toPersianDigits(draft.length)} از {toPersianDigits(BOTTOM_NAV_MAX)}
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-1">
          {options.map((item) => {
            const Icon = NAV_ICONS[item.href] ?? CircleIcon;
            const picked = draft.includes(item.href);
            const blocked = !picked && full;
            return (
              <li key={item.href}>
                <button
                  type="button"
                  disabled={blocked}
                  aria-pressed={picked}
                  /* A greyed row with no explanation reads as broken; say why. */
                  title={blocked ? `ابتدا یکی از ${toPersianDigits(BOTTOM_NAV_MAX)} انتخاب فعلی را بردارید` : undefined}
                  onClick={() => setDraft((entries) => toggleBottomNavHref(entries, item.href))}
                  className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 disabled:cursor-not-allowed disabled:opacity-40 ${
                    picked
                      ? "bg-amber-100 dark:bg-amber-500/20 font-semibold text-amber-700 dark:text-amber-300"
                      : "text-foreground/80 hover:bg-muted/60"
                  }`}
                >
                  <Icon aria-hidden="true" className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-start">{item.label}</span>
                  {picked ? <CheckIcon aria-hidden="true" className="size-4 shrink-0" /> : null}
                </button>
              </li>
            );
          })}
        </ul>
        <DialogFooter showCloseButton>
          <Button
            onClick={() => {
              onSave(draft);
              setOpen(false);
            }}
          >
            ذخیره
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}



function DashboardSidebarFooter({
  role,
  fullName,
  navItems,
  bottomNavHrefs,
  onSaveBottomNav,
}: {
  role: string;
  fullName: string;
  navItems: NavItem[];
  bottomNavHrefs: string[];
  onSaveBottomNav: (hrefs: string[]) => void;
}) {
  const { expandSidebar } = useSidebar();
  const isPinRole = PIN_ROLES.includes(role);

  return (
    <SidebarFooter className="border-border/80 bg-card group-data-[state=collapsed]/sidebar:p-2">
      <div className="space-y-2 group-data-[state=collapsed]/sidebar:hidden">
        {/* The branch switcher used to be here. It moved to the rail's header,
            beside the business name: it answers "where am I working", which is
            context for the whole screen rather than one of the account actions
            it was sitting among. */}
        {/* #541's user menu owns the member's identity and the way out. It is
            kept as the one identity control; the truncation below is this
            branch's fix, since a long name used to push the chevron out of the
            rail. */}
        <PlatformUserMenu role={role} fullName={fullName} />
        <div className="md:hidden"><ThemeToggle /></div>
        <BottomNavSettings
          navItems={navItems}
          current={bottomNavHrefs}
          onSave={onSaveBottomNav}
        />
        {isPinRole && <ShiftButton />}
        {isPinRole && <BiometricSettingsButton />}
        {isPinRole && <LockButton />}
      </div>

      {/*
        Collapsed, the whole footer used to be `hidden` — and #541's user menu,
        which now owns sign-out, is inside that hidden block, so the exit from a
        locked-down POS rail still meant expanding the rail first and hunting.
        The rail keeps the two things that must never be more than one click
        away: who you are (widens the rail back out) and the exit.
      */}
      {/*
        Collapsed, the whole footer used to be `hidden`, and the identity menu
        with it — so the exit from a locked-down POS rail meant expanding the
        rail first and hunting. The rail now carries the same menu as the
        expanded footer, as an avatar button: one implementation, so «تنظیمات
        پلتفرم» and «خروج» are one click away at either width. It is portalled,
        which is what lets it escape the 4rem rail's clipping instead of being
        cut off by it.
      */}
      <div className="hidden flex-col items-center gap-1 group-data-[state=collapsed]/sidebar:flex">
        <PlatformUserMenu role={role} fullName={fullName} compact />
        <button
          type="button"
          onClick={expandSidebar}
          aria-label="باز کردن نوار کناری"
          title="باز کردن نوار کناری"
          className="flex size-9 items-center justify-center rounded-lg border border-input text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45"
        >
          <UsersIcon aria-hidden="true" className="size-4" />
        </button>
      </div>
    </SidebarFooter>
  );
}

/**
 * Closes the phone drawer whenever the route actually changes.
 *
 * Every menu wires an `onNavigate` for this, but the ones that forgot (the
 * workspace rail's «گفت‌وگوی جدید» and «پروژه‌ها», an app launcher, a link
 * inside a page rendered under the open drawer) left the sheet sitting over the
 * page the member had just asked for. Watching the pathname covers all of them
 * at once, and it also handles the browser's back button, which no click
 * handler ever sees.
 */
function CloseDrawerOnNavigate({ pathname }: { pathname: string }) {
  const { setOpenMobile } = useSidebar();
  useEffect(() => {
    setOpenMobile(false);
  }, [pathname, setOpenMobile]);
  return null;
}

/**
 * The app that owns the sidebar slot on this route — its registry def and the
 * component that draws its menu, resolved together so the pair can never
 * disagree (a def whose app forgot to register a menu, or a menu with no app).
 * Null means the business's flat nav keeps the slot, which is what every page
 * outside a shell shows.
 */
function appShellForSlot(
  pathname: string,
  showWorkspaceRail: boolean,
): { shell: AppShellDef; nav: (props: AppShellNavProps) => React.ReactElement } | null {
  if (showWorkspaceRail) return null;
  const shell = appShellForPathname(pathname);
  const nav = shell ? appShellNavFor(shell.app) : undefined;
  return shell && nav ? { shell, nav } : null;
}

/**
 * An app's own main sidebar, in the slot the business nav would otherwise take.
 *
 * Same deal as `SidebarNavigation`: `useSidebar()` is below the provider, so the
 * drawer-closing callback is wired here rather than in the app's component — an
 * app that owns a menu should not have to know the shell's plumbing.
 */
function AppShellNavigation({
  nav: Nav,
  shell,
  role,
  pathname,
  navItems,
  workspaceShell,
}: {
  nav: (props: AppShellNavProps) => React.ReactElement;
  shell: AppShellDef;
  role: string;
  pathname: string;
  /** The business nav, for an app menu that arranges business pages (Accounting). */
  navItems: NavItem[];
  workspaceShell: boolean;
}) {
  const { setOpenMobile } = useSidebar();
  const search = useSearchParams();
  return (
    <Nav
      shell={shell}
      role={role}
      pathname={pathname}
      search={search.toString()}
      // Flattened, so a child page (لیست قیمت under محصولات) can be adopted by
      // an app's menu as well as its parent.
      navItems={flattenNav(navItems)}
      workspaceShell={workspaceShell}
      onNavigate={() => setOpenMobile(false)}
    />
  );
}

function MobileDashboardHeader({ navItems, pathname }: Pick<SidebarProps, "navItems"> & { pathname: string }) {
  const [online, setOnline] = useState(true);
  const search = useSearchParams();
  // The longest matching href wins, and sub-sections are searched too: on
  // «لیست قیمت» the header used to fall back to the generic «داشبورد», because
  // it only scanned the nav's top level and took the first prefix match.
  const active = bestNavMatch(flattenNav(navItems), (href) => isActive(pathname, href, search));
  const today = toPersianDigits(formatJalali(new Date(), { withMonthName: true }));

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  return (
    <header className="sticky top-0 z-30 flex min-h-14 items-center gap-2 border-b border-border/80 bg-card/95 px-2 py-1 backdrop-blur md:hidden">
      <SidebarTrigger className="text-muted-foreground" />
      <div className="min-w-0 flex-1 text-start">
        <p className="truncate text-sm font-bold text-foreground">{active?.label ?? "داشبورد"}</p>
        <p className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
          <CalendarDaysIcon className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{today}</span>
        </p>
      </div>
      {/* On a phone the rail is behind the hamburger, so without this the
          active branch was invisible on every screen until the drawer was
          opened — the one place a mis-set branch does the most damage. */}
      <BranchSwitcher compact />
      <CreditBadge />
      <span
        className="flex min-h-11 min-w-8 items-center justify-center"
        role="status"
        aria-label={online ? "اتصال برقرار است" : "اتصال قطع است"}
        title={online ? "اتصال برقرار است" : "اتصال قطع است"}
      >
        <span
          className={`size-2.5 rounded-full ${online ? "bg-emerald-500 dark:bg-emerald-500" : "bg-destructive"}`}
          aria-hidden="true"
        />
      </span>
    </header>
  );
}

/**
 * The phone's bottom bar: the pages the member picked, and nothing else.
 *
 * It used to end in a «پروفایل» button that opened the drawer. The drawer is
 * already one tap away from the hamburger in the header on every screen, so
 * that slot was a second door to the same room — and it cost the bar a fifth of
 * its width for a control nobody was looking for down there.
 */
function MobileBottomNavigation({
  navItems,
  pathname,
  hrefs,
}: Pick<SidebarProps, "navItems"> & { pathname: string; hrefs: string[] }) {
  const search = useSearchParams();
  // Sub-sections are pinnable now, so the lookup has to see them: a pinned
  // «لیست قیمت» silently vanished from the bar when only the top level was read.
  const byHref = new Map(flattenNav(navItems).map((item) => [item.href, item]));
  const primaryItems = hrefs.flatMap((href) => {
    const item = byHref.get(href);
    return item ? [item] : [];
  });

  if (primaryItems.length === 0) return null;

  // Exactly one tab lights up: the longest matching href, so pinning both a
  // section and one of its tabs no longer paints two active tabs at once.
  const activeHref =
    bestNavMatch(primaryItems, (href) => isActive(pathname, href, search))?.href ?? null;

  return (
    <nav
      /*
        Height comes from `--app-bottom-nav` (globals.css) rather than from the
        sum of this element's own padding: everything that has to sit on top of
        this bar offsets from that variable, so the bar has to be what the
        variable says it is.
      */
      className="fixed inset-x-0 bottom-0 z-40 flex h-[var(--app-bottom-nav)] gap-0.5 border-t border-border/80 bg-card/95 px-1 pb-[env(safe-area-inset-bottom)] pt-1 shadow-[0_-1px_8px_rgb(41_37_36/0.04)] backdrop-blur md:hidden"
      aria-label="ناوبری اصلی"
    >
      {primaryItems.map((item) => {
        const Icon = NAV_ICONS[item.href] ?? CircleIcon;
        const active = item.href === activeHref;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            title={item.label}
            className={`flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-0.5 text-[10px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 active:scale-[0.98] ${active ? "bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}
          >
            <Icon className="size-5 shrink-0" aria-hidden="true" />
            {/*
              A long label used to be truncated to a couple of glyphs plus an
              ellipsis in a quarter of a phone's width («صندوق (فروش)» became
              «صن…»). Two short lines fit the real names instead, and the clamp
              keeps the bar at the height `--app-bottom-nav` promises.
            */}
            <span className="line-clamp-2 w-full text-center leading-tight break-words">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * The drag edge of the sidebar: grab it to change the width (the rail and the
 * classic sidebar alike), double-click to snap back to the default, and the
 * arrow keys move it in steps. The width is remembered per device.
 *
 * It is a real `separator` with a value now, so a screen reader says how wide
 * the sidebar is rather than announcing a nameless handle, and the grip only
 * inks on hover/focus — a permanently visible bar down the edge of the nav
 * would compete with the entries beside it.
 */
function SidebarResizeHandle({
  width,
  onWidthChange,
  onDragChange,
  onReset,
}: {
  /** The sidebar's current rendered width, so a drag always starts from the truth. */
  width: number;
  onWidthChange: (width: number) => void;
  onDragChange: (dragging: boolean) => void;
  onReset: () => void;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const widthRef = useRef(width);

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Left button / primary touch only: a right-click used to start a drag
      // that no pointerup would ever end.
      if (event.button !== 0) return;
      start.current = { x: event.clientX, width: widthRef.current };
      onDragChange(true);
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [onDragChange],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!start.current) return;
      // The sidebar sits on the right; pulling the edge left widens it.
      const next = Math.min(
        SIDEBAR_MAX_WIDTH,
        Math.max(SIDEBAR_MIN_WIDTH, start.current.width + (start.current.x - event.clientX)),
      );
      onWidthChange(next);
    },
    [onWidthChange],
  );

  const endDrag = useCallback(() => {
    if (!start.current) return;
    start.current = null;
    onDragChange(false);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  }, [onDragChange]);

  // A drag that ends outside the window (the pointer left the viewport, the tab
  // lost focus) never fired pointerup on the handle, so the page stayed
  // unselectable with a resize cursor until the next click.
  useEffect(() => {
    const cancel = () => endDrag();
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [endDrag]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // Home/End jump to the bounds and Enter/Space resets, so the width is
      // fully reachable without a pointer — the arrows alone meant up to
      // fourteen presses to cross the range.
      if (event.key === "Home") {
        event.preventDefault();
        onWidthChange(SIDEBAR_MAX_WIDTH);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        onWidthChange(SIDEBAR_MIN_WIDTH);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onReset();
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const direction = event.key === "ArrowLeft" ? 1 : -1;
      onWidthChange(
        Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, widthRef.current + direction * SIDEBAR_KEYBOARD_STEP)),
      );
    },
    [onReset, onWidthChange],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="تغییر عرض نوار کناری"
      aria-valuenow={Math.round(width)}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      aria-valuetext={`${toPersianDigits(String(Math.round(width)))} پیکسل`}
      title="برای تغییر عرض بکشید — دوبار کلیک برای بازگشت به حالت پیش‌فرض"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      /*
        A 1.5px strip was a pixel-hunt to grab. The target is 12px wide with the
        ink still a hairline, which is the standard trick for a resize edge:
        easy to hit, invisible until you mean it.
      */
      className="group/resize absolute inset-y-0 end-0 z-10 hidden w-3 -me-1 cursor-col-resize touch-none items-center justify-center outline-none md:flex"
    >
      <span
        aria-hidden="true"
        className="h-full w-1 rounded-full bg-transparent transition-colors group-hover/resize:bg-amber-300/70 group-focus-visible/resize:bg-amber-400/80 dark:group-hover/resize:bg-amber-500/30 dark:group-focus-visible/resize:bg-amber-400/50"
      />
    </div>
  );
}

export function DashboardSidebar({
  navItems,
  role,
  fullName,
  brandTitle,
  brandSubtitle,
  variant = "classic",
}: SidebarProps) {
  const pathname = usePathname();
  const [preference, setPreference] = useState<DashboardSidebarPreference>("expanded");
  const [preferenceLoaded, setPreferenceLoaded] = useState(false);
  const [tabletMode, setTabletMode] = useState(false);
  const [tabletExpanded, setTabletExpanded] = useState(false);
  const [bottomNav, setBottomNav] = useState<string[] | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(null);
  const [draggingWidth, setDraggingWidth] = useState(false);
  const mode = tabletMode ? (tabletExpanded ? "expanded" : "collapsed") : resolveSidebarMode(pathname, preference);
  // The assistant surfaces (the `/ai` page and, with the workspace
  // shell, the chat home `/dashboard`) have their own in-app nav
  // (conversations/projects) and a pinned composer, so the customizable mobile
  // bottom bar and the global mobile header stand aside there rather than being
  // stacked under or over the assistant's own chrome.
  const workspaceShell = variant === "workspace";
  const assistantRoute = isAssistantSurface(pathname, workspaceShell);
  // On the dedicated assistant page the assistant renders its own header and a
  // nav toggle (the conversations/projects drawer), so the dashboard's global
  // mobile header would only duplicate it. The workspace chat home keeps the
  // global header — its hamburger is the only way to reach the rail on a phone.
  const assistantPage = pathname === "/ai" || pathname.startsWith("/ai/");
  // Sub-sections included, so a pinned child page survives the "is this still
  // visible to me?" filter the bottom bar runs on every render.
  const availableHrefs = flattenNav(navItems).map((item) => item.href);
  // The rail is the workspace *home* — the chat plus the projects surface.
  // Everywhere else the sidebar is an app's nav: either the app that owns the
  // route has a shell of its own (رشد و بازاریابی), or it is the business's flat
  // nav, which is what the accounting suite is.
  const showWorkspaceRail =
    workspaceShell && (pathname === "/dashboard" || pathname.startsWith("/projects"));
  // The app whose routes own the sidebar slot, if this route is one of them.
  // `app-shells.ts` is the registry, so adding a separate app never means
  // editing this file again.
  const appShell = appShellForSlot(pathname, showWorkspaceRail);
  // «رشد و بازاریابی» and «دستیار هوشمند» are not entries in the business's flat
  // nav when the workspace shell is on: they are separate products launched from
  // the rail, and the growth app now carries its own main menu. Listing them
  // alongside حسابداری and گزارش‌ها is what made a separate app read as a page of
  // accounting. In the classic shell, with no rail to launch from, the growth
  // entry stays — it is the only door into the app.
  const appNavItems =
    workspaceShell && !showWorkspaceRail
      ? navItems.filter(
          (item) => item.module !== "ai" && !(item.href && isInsideAnyAppShell(item.href)),
        )
      : navItems;

  useEffect(() => {
    setPreference(window.localStorage.getItem(SIDEBAR_PREFERENCE_KEY) === "collapsed" ? "collapsed" : "expanded");
    setPreferenceLoaded(true);
    const storedWidth = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(storedWidth) && storedWidth >= SIDEBAR_MIN_WIDTH && storedWidth <= SIDEBAR_MAX_WIDTH) {
      setSidebarWidth(storedWidth);
    }
  }, []);

  // Read after mount, not during render: localStorage does not exist on the
  // server, and the first paint has to match what the server sent.
  useEffect(() => {
    setBottomNav(parseBottomNavHrefs(window.localStorage.getItem(BOTTOM_NAV_STORAGE_KEY)));
  }, []);

  const saveBottomNav = useCallback((hrefs: string[]) => {
    setBottomNav(hrefs);
    window.localStorage.setItem(BOTTOM_NAV_STORAGE_KEY, JSON.stringify(hrefs));
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px) and (max-width: 1023px)");
    const update = () => {
      setTabletMode(media.matches);
      if (media.matches) setTabletExpanded(false);
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (preferenceLoaded) window.localStorage.setItem(SIDEBAR_PREFERENCE_KEY, preference);
  }, [preference, preferenceLoaded]);

  // Persist a finished resize; the drag itself just paints.
  useEffect(() => {
    if (draggingWidth || sidebarWidth === null) return;
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth, draggingWidth]);

  const setExpanded = useCallback((expanded: boolean) => {
    if (tabletMode) {
      setTabletExpanded(expanded);
      return;
    }
    setPreference(expanded ? "expanded" : "collapsed");
  }, [tabletMode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.key.toLowerCase() !== "b") return;
      // Ctrl/Cmd+B is "bold" inside a text field or a rich-text editor. The
      // shortcut used to fire anywhere, so bolding a line in the assistant's
      // composer or a note field collapsed the sidebar out from under you.
      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        (target instanceof HTMLElement &&
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }
      event.preventDefault();
      if (tabletMode) {
        setTabletExpanded((current) => !current);
      } else {
        setPreference((current) => toggleDashboardSidebarPreference(current));
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tabletMode]);

  const resetWidth = useCallback(() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH), []);

  return (
    <SidebarProvider open={mode === "expanded"} onOpenChange={setExpanded}>
      <CloseDrawerOnNavigate pathname={pathname} />
      {!assistantPage ? <MobileDashboardHeader navItems={navItems} pathname={pathname} /> : null}
      <Sidebar
        side="right"
        className={`border-border/80 bg-card text-foreground ${draggingWidth ? "transition-none" : ""}`}
        style={
          mode === "expanded" && sidebarWidth !== null && sidebarWidth !== SIDEBAR_DEFAULT_WIDTH
            ? { width: sidebarWidth }
            : undefined
        }
      >
        <SidebarBrand title={brandTitle} subtitle={brandSubtitle} />
        {showWorkspaceRail ? (
          <WorkspaceRail navItems={navItems} pathname={pathname} />
        ) : appShell && appShell.shell.app !== "accounting" ? (
          <AppShellNavigation
            nav={appShell.nav}
            shell={appShell.shell}
            role={role}
            pathname={pathname}
            navItems={navItems}
            workspaceShell={workspaceShell}
          />
        ) : (
          <SidebarNavigation
            navItems={navItems}
            role={role}
            pathname={pathname}
            showWorkspaceHome={workspaceShell}
          />
        )}
        <DashboardSidebarFooter
          role={role}
          fullName={fullName}
          navItems={navItems}
          // The picker always opens on the plain default, never the sell-screen
          // substitution — that swap is a live behaviour of an unconfigured bar,
          // not a saved choice, so offering it as one would silently freeze it.
          bottomNavHrefs={resolveBottomNavHrefs(bottomNav, availableHrefs, false)}
          onSaveBottomNav={saveBottomNav}
        />
        {mode === "expanded" ? (
          <SidebarResizeHandle
            width={sidebarWidth ?? SIDEBAR_DEFAULT_WIDTH}
            onWidthChange={setSidebarWidth}
            onDragChange={setDraggingWidth}
            onReset={resetWidth}
          />
        ) : null}
      </Sidebar>
      {!assistantRoute ? (
        <MobileBottomNavigation
          navItems={navItems}
          pathname={pathname}
          hrefs={resolveBottomNavHrefs(bottomNav, availableHrefs, isActive(pathname, ACCOUNTING_WORKSPACE_HREFS.pos))}
        />
      ) : null}
    </SidebarProvider>
  );
}
