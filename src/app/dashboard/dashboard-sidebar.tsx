"use client";

import { useCallback, useEffect, useState } from "react";
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
  FolderIcon,
  GemIcon,
  LayoutDashboardIcon,
  LayoutGridIcon,
  LockIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  PackageIcon,
  SettingsIcon,
  ShoppingCartIcon,
  SparklesIcon,
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
import { appsForNav } from "@/lib/apps";
import type { Industry } from "@/lib/industries";
import {
  resolveSidebarMode,
  toggleDashboardSidebarPreference,
  type DashboardSidebarPreference,
} from "@/lib/sidebar-state";
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
};

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
   * Phase 35 Wave 2 — which shell to render. `"classic"` is the flat nav that
   * has always been here; `"workspace"` is the new rail (New chat / Projects /
   * Apps / Recent threads). The flag is decided in the layout; this is purely
   * the visual switch, so there is one sidebar with one `if`, not two trees.
   */
  variant?: "classic" | "workspace";
  /** The business's industry, used to group nav items into apps in the rail. */
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
}: {
  navItems: NavItem[];
  pathname: string;
  onNavigate: () => void;
}) {
  return (
    <SidebarContent className="px-3 py-4">
      <nav aria-label="ناوبری داشبورد">
        <SidebarMenu className="space-y-1.5">
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
                  className="min-h-12 rounded-xl text-[#3C3A36] hover:bg-[#FFF9EE] hover:text-[#9B6700] data-[active=true]:bg-[#FFF1D8] data-[active=true]:font-semibold data-[active=true]:text-[#B97905]"
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
                        className="ms-auto size-3.5 shrink-0 text-[#A8A49A] group-data-[state=collapsed]/sidebar:hidden"
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
 * The workspace rail (Phase 35 Wave 2). Replaces the flat nav when the
 * `workspace` flag is on: a "new chat" action, a Projects placeholder (filled
 * in by Wave 3), the apps grouped from the nav items via `appsForNav`, and the
 * member's recent threads. Clicking a thread hands its id to the chat home at
 * `/dashboard?conversation=…`; clicking a page navigates to it. The collapse
 * preference, tablet mode, ⌘/Ctrl-B, mobile header, bottom nav and footer are
 * all inherited from the surrounding shell — only this middle block changed.
 */
function WorkspaceRail({
  navItems,
  pathname,
  industry,
}: {
  navItems: NavItem[];
  pathname: string;
  industry?: Industry;
}) {
  const router = useRouter();
  const grouped = appsForNav(navItems, industry);

  return (
    <SidebarContent className="px-3 py-4">
      <nav aria-label="میز کار" className="space-y-4">
        <SidebarMenu className="space-y-1.5">
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={pathname === "/dashboard"} className="min-h-12 rounded-xl text-[#3C3A36] hover:bg-[#FFF9EE] hover:text-[#9B6700] data-[active=true]:bg-[#FFF1D8] data-[active=true]:font-semibold data-[active=true]:text-[#B97905]">
              <Link href="/dashboard">
                <MessageSquarePlusIcon aria-hidden="true" className="size-5 shrink-0" />
                <span className="group-data-[state=collapsed]/sidebar:hidden">گفت‌وگوی جدید</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {/* Phase 35 Wave 3 — Projects are now functional. */}
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={pathname.startsWith("/dashboard/projects")} className="min-h-12 rounded-xl text-[#3C3A36] hover:bg-[#FFF9EE] hover:text-[#9B6700] data-[active=true]:bg-[#FFF1D8] data-[active=true]:font-semibold data-[active=true]:text-[#B97905]">
              <Link href="/dashboard/projects">
                <FolderIcon aria-hidden="true" className="size-5 shrink-0" />
                <span className="group-data-[state=collapsed]/sidebar:hidden">پروژه‌ها</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>

        <div>
          <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">برنامه‌ها</p>
          <SidebarMenu className="space-y-1.5">
            {grouped.map(({ app, items }) => (
              <SidebarMenuItem key={app.key}>
                <details className="group/app rounded-xl">
                  <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-2 py-2 text-sm text-[#3C3A36] transition hover:bg-[#FFF9EE] hover:text-[#9B6700]">
                    <LayoutGridIcon aria-hidden="true" className="size-4 shrink-0 text-[#A8A49A]" />
                    <span className="min-w-0 flex-1 truncate">{app.label}</span>
                    <span className="text-[10px] text-muted-foreground">{items.length}</span>
                  </summary>
                  <ul className="ms-3 mt-1 space-y-1 border-s-2 border-stone-200 ps-2">
                    {items
                      .filter((item): item is NavItem & { href: string } => Boolean(item.href))
                      .map((item) => {
                        const Icon = NAV_ICONS[item.href] ?? CircleIcon;
                        const active = isActive(pathname, item.href);
                        return (
                          <li key={item.label}>
                            <Link
                              href={item.href}
                              aria-current={active ? "page" : undefined}
                              className={`flex min-h-9 items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition ${
                                active
                                  ? "bg-[#FFF1D8] font-semibold text-[#B97905]"
                                  : "text-[#3C3A36] hover:bg-[#FFF9EE] hover:text-[#9B6700]"
                              }`}
                            >
                              <Icon aria-hidden="true" className="size-4 shrink-0" />
                              <span className="min-w-0 flex-1 truncate">{item.label}</span>
                              {item.locked ? (
                                <LockIcon aria-hidden="true" className="size-3 shrink-0 text-[#A8A49A]" />
                              ) : null}
                            </Link>
                          </li>
                        );
                      })}
                  </ul>
                </details>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </div>

        <div>
          <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">نخ‌های اخیر</p>
          {/* AiRecentConversations already filters to dashboard-mode threads and
              shows its own empty/loading states; selecting one opens it in the
              chat home. */}
          <AiRecentConversations
            activeId={null}
            refreshKey={0}
            onSelect={(id) => router.push(`/dashboard?conversation=${id}`)}
          />
        </div>
      </nav>
    </SidebarContent>
  );
}

function SidebarBrand({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <SidebarHeader className="border-[#EAE8E2] bg-white p-4">
      <div className="flex items-start justify-between gap-2 group-data-[state=collapsed]/sidebar:justify-center">
        <div className="min-w-0 group-data-[state=collapsed]/sidebar:hidden">
          <p className="truncate font-bold text-[#252522]">{title}</p>
          <p className="text-xs text-[#77756F]">{subtitle}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span className="hidden md:block group-data-[state=collapsed]/sidebar:hidden"><ThemeToggle /></span>
          <SidebarTrigger className="hidden text-[#5E5B55] md:inline-flex" />
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
                    picked ? "bg-[#FFF1D8] font-semibold text-[#B97905]" : "text-[#3C3A36]"
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
  return (
    <SidebarFooter className="border-[#EAE8E2] bg-white">
      <div className="group-data-[state=collapsed]/sidebar:hidden">
        <BranchSwitcher />
        <p className="font-semibold text-[#252522]">{fullName}</p>
        <p className="mb-3 text-xs text-[#77756F]">{ROLE_LABELS[role] ?? role}</p>
        <div className="mb-3 md:hidden"><ThemeToggle /></div>
        <BottomNavSettings
          navItems={navItems}
          current={bottomNavHrefs}
          onSave={onSaveBottomNav}
        />
        {PIN_ROLES.includes(role) && <ShiftButton />}
        {PIN_ROLES.includes(role) && <BiometricSettingsButton />}
        {PIN_ROLES.includes(role) && <LockButton />}
        <LogoutButton />
      </div>
    </SidebarFooter>
  );
}

function SidebarNavigation({ navItems, pathname }: Pick<SidebarProps, "navItems"> & { pathname: string }) {
  const { setOpenMobile } = useSidebar();
  return <NavLinks navItems={navItems} pathname={pathname} onNavigate={() => setOpenMobile(false)} />;
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
    <header className="sticky top-0 z-30 flex min-h-14 items-center gap-2 border-b border-[#EAE8E2] bg-white/95 px-2 py-1 backdrop-blur md:hidden">
      <SidebarTrigger className="text-[#52504B]" />
      <div className="min-w-0 flex-1 text-right">
        <p className="truncate text-sm font-bold text-[#252522]">{active?.label ?? "داشبورد"}</p>
        <p className="mt-0.5 flex items-center gap-1 text-[10px] text-[#77756F]"><CalendarDaysIcon className="size-3" aria-hidden="true" />{today}</p>
      </div>
      <span className="flex min-h-11 min-w-11 items-center justify-center" role="status" aria-label={online ? "اتصال برقرار است" : "اتصال قطع است"}>
        <span className={`size-2.5 rounded-full ${online ? "bg-[#36B56A]" : "bg-[#D95757]"}`} aria-hidden="true" />
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
      className="fixed inset-x-0 bottom-0 z-40 flex h-[var(--app-bottom-nav)] border-t border-[#EAE8E2] bg-white/95 px-1 pb-[env(safe-area-inset-bottom)] pt-1 shadow-[0_-1px_8px_rgba(37,37,34,0.04)] backdrop-blur md:hidden"
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
            className={`flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[10px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45 active:scale-[0.98] ${active ? "bg-[#FFF1D8] text-[#B97905]" : "text-[#77756F]"}`}
          >
            <Icon className="size-5 shrink-0" aria-hidden="true" />
            <span className="max-w-full truncate">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

export function DashboardSidebar({
  navItems,
  role,
  fullName,
  brandTitle,
  brandSubtitle,
  variant = "classic",
  industry,
}: SidebarProps) {
  const pathname = usePathname();
  const [preference, setPreference] = useState<DashboardSidebarPreference>("expanded");
  const [preferenceLoaded, setPreferenceLoaded] = useState(false);
  const [tabletMode, setTabletMode] = useState(false);
  const [tabletExpanded, setTabletExpanded] = useState(false);
  const [bottomNav, setBottomNav] = useState<string[] | null>(null);
  const mode = tabletMode ? (tabletExpanded ? "expanded" : "collapsed") : resolveSidebarMode(pathname, preference);
  const availableHrefs = navItems.flatMap((item) => (item.href ? [item.href] : []));

  useEffect(() => {
    setPreference(window.localStorage.getItem(SIDEBAR_PREFERENCE_KEY) === "collapsed" ? "collapsed" : "expanded");
    setPreferenceLoaded(true);
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

  return (
    <SidebarProvider open={mode === "expanded"} onOpenChange={setExpanded}>
      <MobileDashboardHeader navItems={navItems} pathname={pathname} />
      <Sidebar side="right" className="border-[#EAE8E2] bg-white text-[#252522]">
        <SidebarBrand title={brandTitle} subtitle={brandSubtitle} />
        {variant === "workspace" ? (
          <WorkspaceRail navItems={navItems} pathname={pathname} industry={industry} />
        ) : (
          <SidebarNavigation navItems={navItems} pathname={pathname} />
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
      </Sidebar>
      <MobileBottomNavigation
        navItems={navItems}
        pathname={pathname}
        hrefs={resolveBottomNavHrefs(bottomNav, availableHrefs, isActive(pathname, "/dashboard/pos"))}
      />
    </SidebarProvider>
  );
}
