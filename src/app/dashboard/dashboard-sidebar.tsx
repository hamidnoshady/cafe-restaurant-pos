"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArmchairIcon,
  BarChart3Icon,
  BotIcon,
  Building2Icon,
  CalendarDaysIcon,
  CalculatorIcon,
  ChefHatIcon,
  CircleIcon,
  ClipboardListIcon,
  HardDriveIcon,
  LayoutDashboardIcon,
  MapPinIcon,
  PackageIcon,
  SettingsIcon,
  ShoppingCartIcon,
  TruckIcon,
  UsersIcon,
  UtensilsIcon,
  type LucideIcon,
} from "lucide-react";
import {
  resolveSidebarMode,
  toggleDashboardSidebarPreference,
  type DashboardSidebarPreference,
} from "@/lib/sidebar-state";
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
import { BranchSwitcher } from "./branch-switcher";
import { LogoutButton } from "./logout-button";

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
  "/dashboard/menu": UtensilsIcon,
  "/dashboard/floor": ArmchairIcon,
  "/dashboard/waiter": ArmchairIcon,
  "/dashboard/kitchen": ChefHatIcon,
  "/dashboard/reservations": CalendarDaysIcon,
  "/dashboard/delivery": TruckIcon,
  "/dashboard/inventory": PackageIcon,
  "/dashboard/ledger": CalculatorIcon,
  "/dashboard/reports": BarChart3Icon,
  "/dashboard/team": UsersIcon,
  "/dashboard/branches": Building2Icon,
  "/dashboard/locations": MapPinIcon,
  "/dashboard/backup": HardDriveIcon,
  "/dashboard/ai": BotIcon,
  "/setup": SettingsIcon,
};

export interface NavItem {
  label: string;
  href?: string;
  roles?: string[];
  /** Set when this page is gated by a Phase 17 feature flag; already filtered out of navItems if disabled. */
  flag?: string;
}

interface SidebarProps {
  navItems: NavItem[];
  role: string;
  fullName: string;
}

function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLinks({
  navItems,
  role,
  pathname,
  onNavigate,
}: {
  navItems: NavItem[];
  role: string;
  pathname: string;
  onNavigate: () => void;
}) {
  return (
    <SidebarContent>
      <nav aria-label="ناوبری داشبورد">
        <SidebarMenu>
          {navItems.map((item) => {
            const allowed = !item.roles || item.roles.includes(role);
            const Icon = item.href ? (NAV_ICONS[item.href] ?? CircleIcon) : CircleIcon;

            if (!item.href || !allowed) {
              return (
                <SidebarMenuItem key={item.label}>
                  <SidebarMenuButton type="button" disabled aria-label={item.label} tooltip={item.label}>
                    <Icon aria-hidden="true" className="size-5 shrink-0" />
                    <span className="group-data-[state=collapsed]/sidebar:hidden">{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            }

            const active = isActive(pathname, item.href);
            return (
              <SidebarMenuItem key={item.label}>
                <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
                  <Link
                    href={item.href}
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
    <SidebarHeader>
      <div className="flex items-start justify-between gap-2 group-data-[state=collapsed]/sidebar:justify-center">
        <div className="min-w-0 group-data-[state=collapsed]/sidebar:hidden">
          <p className="truncate font-bold">کافه و رستوران</p>
          <p className="text-xs text-muted-foreground">نسخهٔ آزمایشی</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span className="hidden md:block group-data-[state=collapsed]/sidebar:hidden"><ThemeToggle /></span>
          <SidebarTrigger className="hidden md:inline-flex" />
        </div>
      </div>
    </SidebarHeader>
  );
}

function DashboardSidebarFooter({ role, fullName }: { role: string; fullName: string }) {
  return (
    <SidebarFooter>
      <div className="group-data-[state=collapsed]/sidebar:hidden">
        <BranchSwitcher />
        <p className="font-semibold">{fullName}</p>
        <p className="mb-3 text-xs text-muted-foreground">{ROLE_LABELS[role] ?? role}</p>
        <LogoutButton />
      </div>
    </SidebarFooter>
  );
}

function SidebarNavigation({ navItems, role, pathname }: Omit<SidebarProps, "fullName"> & { pathname: string }) {
  const { setOpenMobile } = useSidebar();
  return <NavLinks navItems={navItems} role={role} pathname={pathname} onNavigate={() => setOpenMobile(false)} />;
}

export function DashboardSidebar({ navItems, role, fullName }: SidebarProps) {
  const pathname = usePathname();
  const [preference, setPreference] = useState<DashboardSidebarPreference>("collapsed");
  const [preferenceLoaded, setPreferenceLoaded] = useState(false);
  const mode = resolveSidebarMode(pathname, preference);

  useEffect(() => {
    setPreference(window.localStorage.getItem(SIDEBAR_PREFERENCE_KEY) === "collapsed" ? "collapsed" : "expanded");
    setPreferenceLoaded(true);
  }, []);

  useEffect(() => {
    if (preferenceLoaded) window.localStorage.setItem(SIDEBAR_PREFERENCE_KEY, preference);
  }, [preference, preferenceLoaded]);

  const setExpanded = useCallback((expanded: boolean) => {
    setPreference(expanded ? "expanded" : "collapsed");
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setPreference((current) => toggleDashboardSidebarPreference(current));
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode]);

  return (
    <SidebarProvider open={mode === "expanded"} onOpenChange={setExpanded}>
      <header className="sticky top-0 z-30 flex min-h-14 items-center justify-between gap-2 border-b bg-card px-3 py-2 md:hidden">
        <SidebarTrigger />
        <p className="min-w-0 flex-1 truncate text-center font-bold">کافه و رستوران</p>
        <ThemeToggle />
      </header>

      <Sidebar side="right">
        <SidebarBrand />
        <SidebarNavigation navItems={navItems} role={role} pathname={pathname} />
        <DashboardSidebarFooter role={role} fullName={fullName} />
      </Sidebar>
    </SidebarProvider>
  );
}
