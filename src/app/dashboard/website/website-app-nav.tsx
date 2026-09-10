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
 * The two managers are collapsible groups now — the same disclosure «محصولات»
 * uses in the accounting sidebar — so a business running both systems sees two
 * doors it can fold, not one long always-open list. «بازگشت» sits at the very
 * top, drawn as a control, and leads out to wherever apps are launched from so
 * the member is never trapped inside.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRightIcon,
  ChevronDownIcon,
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
import { APP_NAV_BUTTON_CLASS, BACK_TO_WORKSPACE_BUTTON_CLASS } from "@/app/dashboard/sidebar-nav-styles";
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

/** Which collapsible manager groups the member left open, per device. */
const OPEN_NAV_GROUPS_KEY = "website-sidebar-open-groups";

function readOpenGroups(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(OPEN_NAV_GROUPS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

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
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  useEffect(() => setOpenGroups(readOpenGroups()), []);

  const toggleGroup = useCallback((label: string) => {
    setOpenGroups((current) => {
      const next = { ...current, [label]: !current[label] };
      try {
        window.localStorage.setItem(OPEN_NAV_GROUPS_KEY, JSON.stringify(next));
      } catch {
        // A device that refuses storage keeps the choice for the session.
      }
      return next;
    });
  }, []);

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

  const cmsItems = CMS_NAV_ITEMS.filter((item) => cmsKeys.includes(item.key));
  const wpItems = WP_NAV_ITEMS.filter((item) => wpKeys.includes(item.key));

  return (
    <SidebarContent className="px-3 py-4">
      <nav aria-label="بخش‌های مدیریت وب‌سایت" className="space-y-4">
        <div className="px-2 group-data-[state=collapsed]/sidebar:hidden">
          <p className="text-sm font-bold text-foreground">{shell.label}</p>
          <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground">{shell.description}</p>
        </div>

        {/* The way out, first — and drawn as a control, not as another section. */}
        <SidebarMenu className="space-y-1.5">
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip={backLabel} className={BACK_TO_WORKSPACE_BUTTON_CLASS}>
              <Link href={backHref} onClick={onNavigate}>
                <ArrowRightIcon aria-hidden="true" className="size-5 shrink-0 rtl:rotate-180" />
                <span className="truncate">{backLabel}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div aria-hidden="true" className="border-t border-border/80" />

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
            <CollapsibleNavGroup
              heading={WEBSITE_NAV_GROUPS[0]}
              items={cmsItems}
              hrefFor={(key) => cmsSectionHref(key as CmsSectionKey)}
              activeFor={(key) => isCmsSectionPathname(pathname, key as CmsSectionKey)}
              iconFor={(key) => CMS_ICONS[key as CmsSectionKey]}
              open={Boolean(openGroups[WEBSITE_NAV_GROUPS[0].label]) || cmsItems.some((item) => isCmsSectionPathname(pathname, item.key))}
              onToggle={() => toggleGroup(WEBSITE_NAV_GROUPS[0].label)}
              onNavigate={onNavigate}
            />
            <CollapsibleNavGroup
              heading={WEBSITE_NAV_GROUPS[1]}
              items={wpItems}
              hrefFor={(key) => wpSectionHref(key as WpSectionKey)}
              activeFor={(key) => isWpSectionPathname(pathname, key as WpSectionKey)}
              iconFor={(key) => WP_ICONS[key as WpSectionKey]}
              open={Boolean(openGroups[WEBSITE_NAV_GROUPS[1].label]) || wpItems.some((item) => isWpSectionPathname(pathname, item.key))}
              onToggle={() => toggleGroup(WEBSITE_NAV_GROUPS[1].label)}
              onNavigate={onNavigate}
            />
          </>
        )}
      </nav>
    </SidebarContent>
  );
}

function CollapsibleNavGroup({
  heading,
  items,
  hrefFor,
  activeFor,
  iconFor,
  open,
  onToggle,
  onNavigate,
}: {
  heading: { label: string; description: string };
  items: readonly { key: string; label: string }[];
  hrefFor: (key: string) => string;
  activeFor: (key: string) => boolean;
  iconFor: (key: string) => typeof LayoutDashboardIcon;
  open: boolean;
  onToggle: () => void;
  onNavigate: () => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-right transition-colors hover:bg-muted/60 group-data-[state=collapsed]/sidebar:hidden"
      >
        <span className="text-[11px] font-bold text-muted-foreground">{heading.label}</span>
        <ChevronDownIcon
          aria-hidden="true"
          className={`ms-auto size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-out ${open ? "" : "-rotate-90"}`}
        />
      </button>
      {open ? (
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
      ) : null}
    </div>
  );
}
