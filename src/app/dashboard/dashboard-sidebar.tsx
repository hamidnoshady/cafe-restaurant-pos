"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArmchairIcon,
  BarChart3Icon,
  BotIcon,
  CalendarDaysIcon,
  CalculatorIcon,
  ChefHatIcon,
  CircleIcon,
  ClipboardListIcon,
  LayoutDashboardIcon,
  PackageIcon,
  SettingsIcon,
  ShoppingCartIcon,
  TruckIcon,
  UserRoundIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import {
  resolveSidebarMode,
  toggleDashboardSidebarPreference,
  type DashboardSidebarPreference,
} from "@/lib/sidebar-state";
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
import { ThemeToggle } from "@/components/theme-toggle";
import { BiometricSettingsButton } from "./biometric-settings";
import { BranchSwitcher } from "./branch-switcher";
import { LockButton } from "./lock-screen";
import { LogoutButton } from "./logout-button";
import { ShiftButton } from "./shift-panel";

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
  "/dashboard/ledger": CalculatorIcon,
  "/dashboard/reports": BarChart3Icon,
  "/dashboard/ai": BotIcon,
  "/dashboard/settings": SettingsIcon,
};

export interface NavItem {
  label: string;
  href?: string;
  roles?: string[];
  /** Set when this page is gated by a Phase 17 feature flag; already filtered out of navItems if disabled. */
  flag?: string;
  /** Server-filtered against the member's effective permission set before reaching the client. */
  requiredAnyPermission?: Permission[];
}

interface SidebarProps {
  navItems: NavItem[];
  role: string;
  fullName: string;
}

/**
 * The browser URL is `/{slug}/dashboard/**` (see src/middleware.ts), but every
 * `NavItem.href` is the canonical, unprefixed `/dashboard/**` path — this
 * splits the two apart so lookups against `NAV_ICONS`/`isActive` keep working
 * unchanged, and hands back the prefix to rebuild real hrefs with it (so a nav
 * click lands on the slugged URL directly, without a middleware redirect hop).
 */
function splitDashboardPrefix(pathname: string): { prefix: string; path: string } {
  const match = pathname.match(/^\/([^/]+)(\/dashboard(?:\/.*)?)$/);
  return match ? { prefix: `/${match[1]}`, path: match[2] } : { prefix: "", path: pathname };
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
  const { prefix, path } = splitDashboardPrefix(pathname);
  return (
    <SidebarContent className="px-3 py-4">
      <nav aria-label="ناوبری داشبورد">
        <SidebarMenu className="space-y-1.5">
          {navItems.map((item) => {
            if (!item.href) return null;
            const Icon = NAV_ICONS[item.href] ?? CircleIcon;
            const active = isActive(path, item.href);
            return (
              <SidebarMenuItem key={item.label}>
                <SidebarMenuButton
                  asChild
                  isActive={active}
                  tooltip={item.label}
                  className="min-h-12 rounded-xl text-[#3C3A36] hover:bg-[#FFF9EE] hover:text-[#9B6700] data-[active=true]:bg-[#FFF1D8] data-[active=true]:font-semibold data-[active=true]:text-[#B97905]"
                >
                  <Link
                    href={`${prefix}${item.href}`}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    aria-label={item.label}
                  >
                    <Icon aria-hidden="true" className="size-5 shrink-0" />
                    <span className="group-data-[state=collapsed]/sidebar:hidden">{item.label}</span>
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

function SidebarBrand() {
  return (
    <SidebarHeader className="border-[#EAE8E2] bg-white p-4">
      <div className="flex items-start justify-between gap-2 group-data-[state=collapsed]/sidebar:justify-center">
        <div className="min-w-0 group-data-[state=collapsed]/sidebar:hidden">
          <p className="truncate font-bold text-[#252522]">کافه و رستوران</p>
          <p className="text-xs text-[#77756F]">مدیریت عملیات روزانه</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span className="hidden md:block group-data-[state=collapsed]/sidebar:hidden"><ThemeToggle /></span>
          <SidebarTrigger className="hidden text-[#5E5B55] md:inline-flex" />
        </div>
      </div>
    </SidebarHeader>
  );
}

function DashboardSidebarFooter({ role, fullName }: { role: string; fullName: string }) {
  return (
    <SidebarFooter className="border-[#EAE8E2] bg-white">
      <div className="group-data-[state=collapsed]/sidebar:hidden">
        <BranchSwitcher />
        <p className="font-semibold text-[#252522]">{fullName}</p>
        <p className="mb-3 text-xs text-[#77756F]">{ROLE_LABELS[role] ?? role}</p>
        <div className="mb-3 md:hidden"><ThemeToggle /></div>
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
  const { path } = splitDashboardPrefix(pathname);
  const active = navItems.find((item) => item.href && isActive(path, item.href));
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

function MobileBottomNavigation({ navItems, pathname }: Pick<SidebarProps, "navItems"> & { pathname: string }) {
  const { prefix, path } = splitDashboardPrefix(pathname);
  const { setOpenMobile } = useSidebar();
  // Keep the established bottom-navigation set on other screens. On POS, replace
  // reports with the cashier tab so the active sales workflow is always visible.
  const primaryHrefs = isActive(path, "/dashboard/pos")
    ? ["/dashboard", "/dashboard/pos", "/dashboard/orders"]
    : ["/dashboard", "/dashboard/orders", "/dashboard/reports"];
  const primaryItems = primaryHrefs
    .map((href) => navItems.find((item) => item.href === href))
    .filter((item): item is NavItem & { href: string } => Boolean(item?.href));

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-[#EAE8E2] bg-white/95 px-1 pb-[env(safe-area-inset-bottom)] pt-1 shadow-[0_-1px_8px_rgba(37,37,34,0.04)] backdrop-blur md:hidden" aria-label="ناوبری اصلی">
      {primaryItems.map((item) => {
        const Icon = NAV_ICONS[item.href] ?? CircleIcon;
        const active = isActive(path, item.href);
        return (
          <Link
            key={item.href}
            href={`${prefix}${item.href}`}
            aria-current={active ? "page" : undefined}
            className={`flex min-h-14 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[10px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45 active:scale-[0.98] ${active ? "bg-[#FFF1D8] text-[#B97905]" : "text-[#77756F]"}`}
          >
            <Icon className="size-5" aria-hidden="true" />
            <span>{item.label}</span>
          </Link>
        );
      })}
      <button
        type="button"
        onClick={() => setOpenMobile(true)}
        className="flex min-h-14 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[10px] font-medium text-[#77756F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45 active:scale-[0.98]"
        aria-label="باز کردن پروفایل و منو"
      >
        <UserRoundIcon className="size-5" aria-hidden="true" />
        <span>پروفایل</span>
      </button>
    </nav>
  );
}

export function DashboardSidebar({ navItems, role, fullName }: SidebarProps) {
  const pathname = usePathname();
  const [preference, setPreference] = useState<DashboardSidebarPreference>("expanded");
  const [preferenceLoaded, setPreferenceLoaded] = useState(false);
  const [tabletMode, setTabletMode] = useState(false);
  const [tabletExpanded, setTabletExpanded] = useState(false);
  const mode = tabletMode ? (tabletExpanded ? "expanded" : "collapsed") : resolveSidebarMode(pathname, preference);

  useEffect(() => {
    setPreference(window.localStorage.getItem(SIDEBAR_PREFERENCE_KEY) === "collapsed" ? "collapsed" : "expanded");
    setPreferenceLoaded(true);
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
        <SidebarBrand />
        <SidebarNavigation navItems={navItems} pathname={pathname} />
        <DashboardSidebarFooter role={role} fullName={fullName} />
      </Sidebar>
      <MobileBottomNavigation navItems={navItems} pathname={pathname} />
    </SidebarProvider>
  );
}
