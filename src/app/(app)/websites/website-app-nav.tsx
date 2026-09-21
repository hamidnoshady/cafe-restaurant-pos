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
import {
  APP_NAV_BUTTON_CLASS,
  BACK_TO_WORKSPACE_BUTTON_CLASS,
  NAV_LABEL_CLASS,
} from "@/app/dashboard/sidebar-nav-styles";
import { api } from "@/app/dashboard/ui";
import { CMS_NAV_ITEMS, WEBSITE_NAV_GROUPS, WP_NAV_ITEMS } from "./website-nav";
import {
  cmsSectionHref,
  EMPTY_WEBSITE_MANAGERS_STATE,
  isCmsSectionPathname,
  isWpSectionPathname,
  visibleCmsSections,
  visibleWpSections,
  WEBSITE_OVERVIEW_HREF,
  WEBSITE_SETTINGS_HREF,
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

export function WebsiteAppNav({ shell, role, pathname, onNavigate }: AppShellNavProps) {
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

  const backHref = "/dashboard";
  const backLabel = "بازگشت به میز کار";
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
                <span className={NAV_LABEL_CLASS}>{backLabel}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div aria-hidden="true" className="border-t border-border/80" />

        <SidebarMenu className="space-y-1.5">
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={pathname === WEBSITE_OVERVIEW_HREF}
              tooltip="خانهٔ برنامه"
              className={APP_NAV_BUTTON_CLASS}
            >
              <Link
                href={WEBSITE_OVERVIEW_HREF}
                onClick={onNavigate}
                aria-current={pathname === WEBSITE_OVERVIEW_HREF ? "page" : undefined}
              >
                <LayoutDashboardIcon aria-hidden="true" className="size-5 shrink-0" />
                <span className={NAV_LABEL_CLASS}>خانهٔ وب‌سایت</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {/* The app's own settings — every app's menu ends with one, and it is
              never the platform settings page. */}
          {canManage ? (
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                isActive={pathname === WEBSITE_SETTINGS_HREF}
                tooltip="تنظیمات وب‌سایت"
                className={APP_NAV_BUTTON_CLASS}
              >
                <Link
                  href={WEBSITE_SETTINGS_HREF}
                  onClick={onNavigate}
                  aria-current={pathname === WEBSITE_SETTINGS_HREF ? "page" : undefined}
                >
                  <SettingsIcon aria-hidden="true" className="size-5 shrink-0" />
                  <span className={NAV_LABEL_CLASS}>تنظیمات وب‌سایت</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : null}
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
      {/* Collapsed to icons the heading below is hidden, so the CMS sections and
          the WordPress sections would read as one undivided column of glyphs. */}
      <div
        aria-hidden="true"
        className="mx-2 hidden border-t border-border/70 group-data-[state=collapsed]/sidebar:block"
      />
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={`${open ? "بستن" : "باز کردن"} ${heading.label}`}
        title={heading.description}
        /* A 22px-tall heading was the smallest tap target in the whole menu. */
        className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2 text-start transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 group-data-[state=collapsed]/sidebar:hidden"
      >
        <span className="min-w-0 flex-1 truncate text-[11px] font-bold text-muted-foreground">{heading.label}</span>
        <ChevronDownIcon
          aria-hidden="true"
          className={`size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-out ${open ? "" : "-rotate-90"}`}
        />
      </button>
      {/*
        Collapsed, there is no chevron to reopen a closed group with, so a closed
        group would leave the rail simply empty. At 4rem the sections are always
        listed; the disclosure is an expanded-rail affordance.
      */}
      <SidebarMenu
        className={open ? "space-y-1.5" : "hidden space-y-1.5 group-data-[state=collapsed]/sidebar:block"}
      >
        {items.map((item) => {
          const active = activeFor(item.key);
          const Icon = iconFor(item.key);
          return (
            <SidebarMenuItem key={item.key}>
              <SidebarMenuButton asChild isActive={active} tooltip={item.label} className={APP_NAV_BUTTON_CLASS}>
                <Link href={hrefFor(item.key)} onClick={onNavigate} aria-current={active ? "page" : undefined}>
                  <Icon aria-hidden="true" className="size-5 shrink-0" />
                  <span className={NAV_LABEL_CLASS}>{item.label}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </div>
  );
}
