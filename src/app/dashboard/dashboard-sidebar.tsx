"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ArmchairIcon,
  BarChart3Icon,
  BotIcon,
  CalendarDaysIcon,
  CalculatorIcon,
  CheckIcon,
  ChefHatIcon,
  CircleIcon,
  ClipboardListIcon,
  ContactIcon,
  FolderIcon,
  GemIcon,
  LayoutDashboardIcon,
  LayoutGridIcon,
  LockIcon,
  MessageSquarePlusIcon,
  PackageIcon,
  SettingsIcon,
  ShoppingCartIcon,
  SparklesIcon,
  TrendingUpIcon,
  TruckIcon,
  UsersIcon,
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
import type { AppKey } from "@/lib/apps";
import { appShellForPathname, isInsideAnyAppShell, type AppShellDef } from "@/lib/app-shells";
import { APP_NAV_BUTTON_CLASS } from "./sidebar-nav-styles";
import { appShellNavFor, type AppShellNavProps } from "./app-shell-nav";
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
import { BiometricSettingsButton } from "./biometric-settings";
import { BranchSwitcher } from "./branch-switcher";
import { LockButton } from "./lock-screen";
import { LogoutButton } from "./logout-button";
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

const ROLE_LABELS: Record<string, string> = {
  owner: "مالک",
  manager: "مدیر",
  accountant: "حسابدار",
  cashier: "صندوق‌دار",
  waiter: "گارسون",
  kitchen: "آشپزخانه",
};

const NAV_ICONS: Record<string, LucideIcon> = {
  "/dashboard": LayoutDashboardIcon,
  "/dashboard/overview": LayoutDashboardIcon,
  "/dashboard/orders": ClipboardListIcon,
  "/dashboard/pos": ShoppingCartIcon,
  "/dashboard/customers": UsersIcon,
  "/dashboard/floor": ArmchairIcon,
  "/dashboard/waiter": ArmchairIcon,
  "/dashboard/kitchen": ChefHatIcon,
  "/dashboard/reservations": CalendarDaysIcon,
  "/dashboard/delivery": TruckIcon,
  "/dashboard/inventory": PackageIcon,
  "/dashboard/jewelry": GemIcon,
  "/dashboard/watch": WatchIcon,
  "/dashboard/accessories": SparklesIcon,
  "/dashboard/ledger": CalculatorIcon,
  "/dashboard/reports": BarChart3Icon,
  "/dashboard/ai": BotIcon,
  "/dashboard/settings": SettingsIcon,
  // Phase 36b — the Growth & Marketing app's home; the trend glyph the
  // workspace rail already uses for «رشد و بازاریابی».
  "/dashboard/growth": TrendingUpIcon,
  // Phase 36 — the CRM app's home. `/dashboard/customers` keeps the plain
  // people glyph above; this is the app that now owns that record.
  "/dashboard/crm": ContactIcon,
};

/**
 * The apps the workspace rail launches, in rail order.
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
 */
const WORKSPACE_APP_LAUNCHERS: readonly {
  key: AppKey;
  label: string;
  icon: LucideIcon;
  hrefs: readonly string[];
}[] = [
  {
    key: "accounting",
    label: "حسابداری",
    icon: CalculatorIcon,
    // The accounting overview is available to every member who can see this
    // rail; ledger and reports stay reachable from the app's own sidebar.
    hrefs: ["/dashboard/overview", "/dashboard/ledger", "/dashboard/reports"],
  },
  {
    key: "crm",
    label: "ارتباط با مشتری",
    icon: ContactIcon,
    // `/dashboard/customers` redirects into the app's directory, so a business
    // that has customers but has never opened the CRM still gets the launcher.
    hrefs: ["/dashboard/crm", "/dashboard/customers"],
  },
  {
    key: "growth",
    label: "رشد و بازاریابی",
    icon: TrendingUpIcon,
    hrefs: [
      "/dashboard/growth",
      "/dashboard/loyalty",
      "/dashboard/promotions",
      "/dashboard/commission",
    ],
  },
];

export interface NavItem {
  label: string;
  /** The industry module that owns this entry (src/lib/industry-profile.ts); already filtered out of navItems for an industry that has no such module. */
  module: ModuleKey;
  href?: string;
  roles?: string[];
  /** Set when this page is gated by a Phase 17 feature flag; already filtered out of navItems if disabled and not lockable. */
  flag?: string;
  /**
   * The flag is off but the feature is lockable (features.ts's
   * LOCKABLE_FEATURES), so the entry stays in the nav and its page renders a
   * read-only preview. Server-computed; the padlock here only labels it.
   */
  locked?: boolean;
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

function isActive(path: string, href: string): boolean {
  if (href === "/dashboard") return path === "/dashboard";
  return path === href || path.startsWith(`${href}/`);
}

function NavLinks({
  navItems,
  pathname,
  onNavigate,
  showWorkspaceHome = false,
}: {
  navItems: NavItem[];
  pathname: string;
  onNavigate: () => void;
  /** True while the business has the workspace shell: adds a «میز کار» entry back to the chat home. */
  showWorkspaceHome?: boolean;
}) {
  return (
    <SidebarContent className="px-3 py-4">
      <nav aria-label="ناوبری داشبورد">
        <SidebarMenu className="space-y-1.5">
          {showWorkspaceHome ? (
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                isActive={pathname === "/dashboard"}
                tooltip="میز کار"
                className={APP_NAV_BUTTON_CLASS}
              >
                <Link href="/dashboard" onClick={onNavigate} aria-current={pathname === "/dashboard" ? "page" : undefined}>
                  <LayoutGridIcon aria-hidden="true" className="size-5 shrink-0" />
                  <span className="group-data-[state=collapsed]/sidebar:hidden">میز کار</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : null}
          {navItems.map((item) => {
            if (!item.href) return null;
            const Icon = NAV_ICONS[item.href] ?? CircleIcon;
            const active = isActive(pathname, item.href);
            return (
              <SidebarMenuItem key={item.label}>
                <SidebarMenuButton
                  asChild
                  isActive={active}
                  tooltip={item.label}
                  className={APP_NAV_BUTTON_CLASS}
                >
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    aria-label={item.locked ? `${item.label} (فعال نیست)` : item.label}
                    title={item.locked ? `${item.label} — برای کسب‌وکار شما فعال نیست` : undefined}
                  >
                    <Icon aria-hidden="true" className="size-5 shrink-0" />
                    <span className="group-data-[state=collapsed]/sidebar:hidden">{item.label}</span>
                    {item.locked ? (
                      <LockIcon
                        aria-hidden="true"
                        className="ms-auto size-3.5 shrink-0 text-stone-400 group-data-[state=collapsed]/sidebar:hidden"
                      />
                    ) : null}
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
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
  const hrefs = navItems.flatMap((item) => (item.href ? [item.href] : []));
  // The apps this rail launches, as data rather than three copies of the same
  // markup. Each entry lists its candidate routes in preference order: a
  // launcher always opens the app's own home, and falls back to a page the
  // app absorbed so a member whose saved bottom-nav still holds an old flat
  // route lands in the app rather than on a 404. An app with no reachable
  // route (its modules are not this trade's) is simply not listed.
  const launchers = WORKSPACE_APP_LAUNCHERS.flatMap((launcher) => {
    const href = launcher.hrefs.find((candidate) => hrefs.includes(candidate));
    return href ? [{ ...launcher, href, active: isActive(pathname, href) }] : [];
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
                <span className="group-data-[state=collapsed]/sidebar:hidden">گفت‌وگوی جدید</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={pathname.startsWith("/dashboard/projects")}
              tooltip="پروژه‌ها"
              className={APP_NAV_BUTTON_CLASS}
            >
              <Link href="/dashboard/projects">
                <FolderIcon aria-hidden="true" className="size-5 shrink-0" />
                <span className="group-data-[state=collapsed]/sidebar:hidden">پروژه‌ها</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>

        {launchers.length > 0 ? (
          <div>
            <p className="px-2 pb-1 text-xs font-medium text-muted-foreground group-data-[state=collapsed]/sidebar:hidden">برنامه‌ها</p>
            <SidebarMenu className="space-y-1.5">
              {launchers.map((launcher) => {
                const Icon = launcher.icon;
                return (
                  <SidebarMenuItem key={launcher.key}>
                    <SidebarMenuButton
                      asChild
                      isActive={launcher.active}
                      tooltip={launcher.label}
                      className={APP_NAV_BUTTON_CLASS}
                    >
                      <Link href={launcher.href}>
                        <Icon aria-hidden="true" className="size-5 shrink-0" />
                        <span className="group-data-[state=collapsed]/sidebar:hidden">{launcher.label}</span>
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
      </nav>
    </SidebarContent>
  );
}

function SidebarBrand({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <SidebarHeader className="border-stone-200/80 bg-white p-4">
      <div className="flex items-start justify-between gap-2 group-data-[state=collapsed]/sidebar:justify-center">
        <div className="min-w-0 group-data-[state=collapsed]/sidebar:hidden">
          <p className="truncate font-bold text-stone-950">{title}</p>
          <p className="text-xs text-stone-500">{subtitle}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span className="hidden md:block group-data-[state=collapsed]/sidebar:hidden"><ThemeToggle /></span>
          <SidebarTrigger className="hidden text-stone-600 md:inline-flex" />
        </div>
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
  const options = navItems.filter((item): item is NavItem & { href: string } => Boolean(item.href));

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
        <button
          type="button"
          className="mb-3 w-full rounded-lg border border-input py-1.5 text-sm text-muted-foreground transition hover:bg-muted/50 md:hidden"
        >
          چیدمان نوار پایین
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
            return (
              <li key={item.href}>
                <button
                  type="button"
                  disabled={!picked && draft.length >= BOTTOM_NAV_MAX}
                  aria-pressed={picked}
                  onClick={() => setDraft((entries) => toggleBottomNavHref(entries, item.href))}
                  className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-sm disabled:opacity-40 ${
                    picked ? "bg-amber-100 font-semibold text-amber-700" : "text-stone-700"
                  }`}
                >
                  <Icon aria-hidden="true" className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-right">{item.label}</span>
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

/**
 * The assistant's own settings page, parked at the bottom of the sidebar next
 * to the member — the way the chat products do it — rather than as another
 * entry in the middle of the nav. Owner and manager only; the page itself
 * guards the same way. `iconOnly` is the collapsed-rail variant (a bare
 * sparkles button, the ChatGPT-style footprint at the bottom of a collapsed
 * sidebar).
 */
function AiSettingsButton({ iconOnly = false }: { iconOnly?: boolean }) {
  if (iconOnly) {
    return (
      <Button
        asChild
        variant="ghost"
        size="icon"
        aria-label="تنظیمات هوش مصنوعی"
        title="تنظیمات هوش مصنوعی"
        className="min-h-11 min-w-11 text-stone-600 hover:bg-amber-50 hover:text-amber-700"
      >
        <Link href="/dashboard/ai/settings">
          <SparklesIcon aria-hidden="true" />
        </Link>
      </Button>
    );
  }
  return (
    <div className="mb-3">
      <Button asChild variant="outline" className="w-full justify-start gap-2">
        <Link href="/dashboard/ai/settings">
          <SparklesIcon aria-hidden="true" className="size-4 shrink-0" />
          تنظیمات هوش مصنوعی
        </Link>
      </Button>
    </div>
  );
}

function DashboardSidebarFooter({
  role,
  fullName,
  navItems,
  bottomNavHrefs,
  onSaveBottomNav,
  showAiSettings,
}: {
  role: string;
  fullName: string;
  navItems: NavItem[];
  bottomNavHrefs: string[];
  onSaveBottomNav: (hrefs: string[]) => void;
  /** Owner/manager with the assistant on their nav — the settings entry is theirs. */
  showAiSettings: boolean;
}) {
  return (
    <SidebarFooter className="border-stone-200/80 bg-white">
      <div className="group-data-[state=collapsed]/sidebar:hidden">
        <BranchSwitcher />
        <p className="font-semibold text-stone-950">{fullName}</p>
        <p className="mb-3 text-xs text-stone-500">{ROLE_LABELS[role] ?? role}</p>
        <div className="mb-3 md:hidden"><ThemeToggle /></div>
        <BottomNavSettings
          navItems={navItems}
          current={bottomNavHrefs}
          onSave={onSaveBottomNav}
        />
        {PIN_ROLES.includes(role) && <ShiftButton />}
        {PIN_ROLES.includes(role) && <BiometricSettingsButton />}
        {PIN_ROLES.includes(role) && <LockButton />}
        {showAiSettings && <AiSettingsButton />}
        <LogoutButton />
      </div>
      {/* Collapsed: everything above hides; this stays as the one footer control. */}
      {showAiSettings ? (
        <div className="hidden justify-center group-data-[state=collapsed]/sidebar:flex">
          <AiSettingsButton iconOnly />
        </div>
      ) : null}
    </SidebarFooter>
  );
}

function SidebarNavigation({ navItems, pathname, showWorkspaceHome }: Pick<SidebarProps, "navItems"> & { pathname: string; showWorkspaceHome: boolean }) {
  const { setOpenMobile } = useSidebar();
  return (
    <NavLinks
      navItems={navItems}
      pathname={pathname}
      showWorkspaceHome={showWorkspaceHome}
      onNavigate={() => setOpenMobile(false)}
    />
  );
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
  workspaceShell,
}: {
  nav: (props: AppShellNavProps) => React.ReactElement;
  shell: AppShellDef;
  role: string;
  pathname: string;
  workspaceShell: boolean;
}) {
  const { setOpenMobile } = useSidebar();
  return (
    <Nav
      shell={shell}
      role={role}
      pathname={pathname}
      workspaceShell={workspaceShell}
      onNavigate={() => setOpenMobile(false)}
    />
  );
}

function MobileDashboardHeader({ navItems, pathname }: Pick<SidebarProps, "navItems"> & { pathname: string }) {
  const [online, setOnline] = useState(true);
  const active = navItems.find((item) => item.href && isActive(pathname, item.href));
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
    <header className="sticky top-0 z-30 flex min-h-14 items-center gap-2 border-b border-stone-200/80 bg-white/95 px-2 py-1 backdrop-blur md:hidden">
      <SidebarTrigger className="text-stone-600" />
      <div className="min-w-0 flex-1 text-right">
        <p className="truncate text-sm font-bold text-stone-950">{active?.label ?? "داشبورد"}</p>
        <p className="mt-0.5 flex items-center gap-1 text-[10px] text-stone-500"><CalendarDaysIcon className="size-3" aria-hidden="true" />{today}</p>
      </div>
      <span className="flex min-h-11 min-w-11 items-center justify-center" role="status" aria-label={online ? "اتصال برقرار است" : "اتصال قطع است"}>
        <span className={`size-2.5 rounded-full ${online ? "bg-emerald-500" : "bg-destructive"}`} aria-hidden="true" />
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
  const primaryItems = hrefs
    .map((href) => navItems.find((item) => item.href === href))
    .filter((item): item is NavItem & { href: string } => Boolean(item?.href));

  if (primaryItems.length === 0) return null;

  return (
    <nav
      /*
        Height comes from `--app-bottom-nav` (globals.css) rather than from the
        sum of this element's own padding: everything that has to sit on top of
        this bar offsets from that variable, so the bar has to be what the
        variable says it is.
      */
      className="fixed inset-x-0 bottom-0 z-40 flex h-[var(--app-bottom-nav)] border-t border-stone-200/80 bg-white/95 px-1 pb-[env(safe-area-inset-bottom)] pt-1 shadow-[0_-1px_8px_rgba(37,37,34,0.04)] backdrop-blur md:hidden"
      aria-label="ناوبری اصلی"
    >
      {primaryItems.map((item) => {
        const Icon = NAV_ICONS[item.href] ?? CircleIcon;
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[10px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 active:scale-[0.98] ${active ? "bg-amber-100 text-amber-700" : "text-stone-500"}`}
          >
            <Icon className="size-5 shrink-0" aria-hidden="true" />
            <span className="max-w-full truncate">{item.label}</span>
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
      start.current = { x: event.clientX, width: widthRef.current };
      onDragChange(true);
      document.body.style.userSelect = "none";
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
  }, [onDragChange]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const direction = event.key === "ArrowLeft" ? 1 : -1;
      onWidthChange(
        Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, widthRef.current + direction * SIDEBAR_KEYBOARD_STEP)),
      );
    },
    [onWidthChange],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="تغییر عرض نوار کناری"
      title="برای تغییر عرض بکشید"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      className="absolute inset-y-0 end-0 z-10 hidden w-1.5 cursor-col-resize touch-none items-center justify-center outline-none transition-colors hover:bg-amber-200/70 focus-visible:bg-amber-200/70 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-400/60 md:flex"
    />
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
  // The assistant surfaces (the `/dashboard/ai` page and, with the workspace
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
  const assistantPage = pathname === "/dashboard/ai" || pathname.startsWith("/dashboard/ai/");
  const availableHrefs = navItems.flatMap((item) => (item.href ? [item.href] : []));
  // The rail is the workspace *home* — the chat plus the projects surface.
  // Everywhere else the sidebar is an app's nav: either the app that owns the
  // route has a shell of its own (رشد و بازاریابی), or it is the business's flat
  // nav, which is what the accounting suite is.
  const showWorkspaceRail =
    workspaceShell && (pathname === "/dashboard" || pathname.startsWith("/dashboard/projects"));
  const showAiSettings = (role === "owner" || role === "manager") && navItems.some((item) => item.module === "ai");
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
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        if (tabletMode) {
          setTabletExpanded((current) => !current);
        } else {
          setPreference((current) => toggleDashboardSidebarPreference(current));
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tabletMode]);

  const resetWidth = useCallback(() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH), []);

  return (
    <SidebarProvider open={mode === "expanded"} onOpenChange={setExpanded}>
      {!assistantPage ? <MobileDashboardHeader navItems={navItems} pathname={pathname} /> : null}
      <Sidebar
        side="right"
        className={`border-stone-200/80 bg-white text-stone-950 ${draggingWidth ? "transition-none" : ""}`}
        style={
          mode === "expanded" && sidebarWidth !== null && sidebarWidth !== SIDEBAR_DEFAULT_WIDTH
            ? { width: sidebarWidth }
            : undefined
        }
      >
        <SidebarBrand title={brandTitle} subtitle={brandSubtitle} />
        {showWorkspaceRail ? (
          <WorkspaceRail navItems={navItems} pathname={pathname} />
        ) : appShell ? (
          <AppShellNavigation
            nav={appShell.nav}
            shell={appShell.shell}
            role={role}
            pathname={pathname}
            workspaceShell={workspaceShell}
          />
        ) : (
          <SidebarNavigation navItems={appNavItems} pathname={pathname} showWorkspaceHome={workspaceShell} />
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
          showAiSettings={showAiSettings}
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
          hrefs={resolveBottomNavHrefs(bottomNav, availableHrefs, isActive(pathname, "/dashboard/pos"))}
        />
      ) : null}
    </SidebarProvider>
  );
}
