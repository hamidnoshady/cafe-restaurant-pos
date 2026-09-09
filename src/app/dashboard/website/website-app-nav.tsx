"use client";

/**
 * «مدیریت وب‌سایت»'s own main sidebar — one menu, two groups.
 *
 * Rendered in the dashboard's app slot for every route under
 * `/dashboard/website` (`src/lib/app-shells.ts` hands the slot over, the same
 * arrangement the CRM and Growth apps use). What is different here, and what
 * this component exists for, is that the menu is **built from the business's
 * real connections**: it asks `/api/website/managers` which of the two systems
 * are set up and lists each manager's sections accordingly — a manager with no
 * connection shows its front page and the screen that connects it, and nothing
 * that would read a site that does not exist.
 *
 * The two groups are never merged. «بازگشت» leads out to wherever apps are
 * launched from so the member is never trapped inside.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ContactIcon,
  CreditCardIcon,
  FileTextIcon,
  FolderTreeIcon,
  ImageIcon,
  LayoutDashboardIcon,
  ReceiptTextIcon,
  SendIcon,
  SettingsIcon,
  ShoppingBagIcon,
  WandSparklesIcon,
} from "lucide-react";
import {
  SidebarContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import type { AppShellNavProps } from "@/app/dashboard/app-shell-nav";
import { APP_NAV_BUTTON_CLASS } from "@/app/dashboard/sidebar-nav-styles";
import { api } from "@/app/dashboard/ui";
import { CMS_NAV_ITEMS, WEBSITE_NAV_GROUPS, WP_NAV_ITEMS } from "./website-nav";
import {
  cmsSectionHref,
  EMPTY_WEBSITE_MANAGERS_STATE,
  isCmsSectionPathname,
  isWpSectionPathname,
  visibleCmsSections,
  visibleWpSections,
  WEBSITE_HOME,
  wpSectionHref,
  type CmsSectionKey,
  type WebsiteManagersState,
} from "./website-routes";
import type { WpSectionKey } from "./wp/wp-routes";

const CMS_ICONS: Record<CmsSectionKey, typeof LayoutDashboardIcon> = {
  overview: LayoutDashboardIcon,
  setup: WandSparklesIcon,
  content: FileTextIcon,
  store: ShoppingBagIcon,
  settings: SettingsIcon,
  billing: CreditCardIcon,
};

const WP_ICONS: Record<WpSectionKey, typeof LayoutDashboardIcon> = {
  overview: LayoutDashboardIcon,
  products: ShoppingBagIcon,
  orders: ReceiptTextIcon,
  customers: ContactIcon,
  taxonomies: FolderTreeIcon,
  content: FileTextIcon,
  media: ImageIcon,
  queue: SendIcon,
};

/** The menu's own loading shape: two group headings and a few rows each. */
function WebsiteNavSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-4 px-2">
      {[0, 1].map((group) => (
        <div key={group} className="space-y-2">
          <Skeleton className="h-3.5 w-24 rounded" />
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-8 w-full rounded-lg" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function WebsiteAppNav({ shell, role, pathname, onNavigate, workspaceShell }: AppShellNavProps) {
  const [state, setState] = useState<WebsiteManagersState | null>(null);

  useEffect(() => {
    let alive = true;
    api<{ managers: WebsiteManagersState }>("/api/website/managers").then(({ ok, data }) => {
      if (!alive) return;
      // A failed read must not hide the app: the menu falls back to "nothing
      // connected", which still lists both front pages and both connect
      // screens — the two things a member can always usefully open.
      setState(ok ? data.managers : EMPTY_WEBSITE_MANAGERS_STATE);
    });
    return () => {
      alive = false;
    };
  }, []);

  const backHref = workspaceShell ? "/dashboard" : "/dashboard/overview";
  const backLabel = workspaceShell ? "بازگشت به میز کار" : "بازگشت به داشبورد";
  const canManage = role === "owner" || role === "manager";

  const cmsKeys = state ? visibleCmsSections(state) : [];
  const wpKeys = state ? visibleWpSections(state) : [];

  return (
    <SidebarContent className="px-3 py-4">
      <nav aria-label="بخش‌های مدیریت وب‌سایت" className="space-y-4">
        <div className="px-2 group-data-[state=collapsed]/sidebar:hidden">
          <p className="text-sm font-bold text-foreground">{shell.label}</p>
          <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground">{shell.description}</p>
        </div>

        <SidebarMenu className="space-y-1.5">
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={pathname === WEBSITE_HOME}
              tooltip="خانهٔ برنامه"
              className={APP_NAV_BUTTON_CLASS}
            >
              <Link href={WEBSITE_HOME} onClick={onNavigate} aria-current={pathname === WEBSITE_HOME ? "page" : undefined}>
                <LayoutDashboardIcon className="size-4 shrink-0" />
                <span className="truncate">خانهٔ وب‌سایت</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>

        {!state ? (
          <WebsiteNavSkeleton />
        ) : !canManage ? (
          <p className="px-2 text-[11px] leading-5 text-muted-foreground group-data-[state=collapsed]/sidebar:hidden">
            مدیریت سایت در اختیار مالک و مدیر است.
          </p>
        ) : (
          <>
            <NavGroup
              heading={WEBSITE_NAV_GROUPS[0]}
              items={CMS_NAV_ITEMS.filter((item) => cmsKeys.includes(item.key))}
              hrefFor={(key) => cmsSectionHref(key as CmsSectionKey)}
              activeFor={(key) => isCmsSectionPathname(pathname, key as CmsSectionKey)}
              iconFor={(key) => CMS_ICONS[key as CmsSectionKey]}
              onNavigate={onNavigate}
            />
            <NavGroup
              heading={WEBSITE_NAV_GROUPS[1]}
              items={WP_NAV_ITEMS.filter((item) => wpKeys.includes(item.key))}
              hrefFor={(key) => wpSectionHref(key as WpSectionKey)}
              activeFor={(key) => isWpSectionPathname(pathname, key as WpSectionKey)}
              iconFor={(key) => WP_ICONS[key as WpSectionKey]}
              onNavigate={onNavigate}
            />
          </>
        )}

        <div className="pt-2">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip={backLabel} className={APP_NAV_BUTTON_CLASS}>
                <Link href={backHref} onClick={onNavigate}>
                  <span className="text-base leading-none">→</span>
                  <span className="truncate">{backLabel}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </div>
      </nav>
    </SidebarContent>
  );
}

function NavGroup({
  heading,
  items,
  hrefFor,
  activeFor,
  iconFor,
  onNavigate,
}: {
  heading: { label: string; description: string };
  items: readonly { key: string; label: string }[];
  hrefFor: (key: string) => string;
  activeFor: (key: string) => boolean;
  iconFor: (key: string) => typeof LayoutDashboardIcon;
  onNavigate: () => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <div className="px-2 group-data-[state=collapsed]/sidebar:hidden">
        <p className="text-[11px] font-bold text-muted-foreground">{heading.label}</p>
      </div>
      <SidebarMenu className="space-y-1.5">
        {items.map((item) => {
          const active = activeFor(item.key);
          const Icon = iconFor(item.key);
          return (
            <SidebarMenuItem key={item.key}>
              <SidebarMenuButton asChild isActive={active} tooltip={item.label} className={APP_NAV_BUTTON_CLASS}>
                <Link href={hrefFor(item.key)} onClick={onNavigate} aria-current={active ? "page" : undefined}>
                  <Icon className="size-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </div>
  );
}
