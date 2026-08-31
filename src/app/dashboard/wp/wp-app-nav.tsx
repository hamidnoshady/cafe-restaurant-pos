"use client";

/**
 * The WordPress & WooCommerce Manager app's own main sidebar.
 *
 * Rendered in the dashboard's app slot for every route under
 * `/dashboard/wp` — `src/lib/app-shells.ts` hands the slot over, the
 * same arrangement the CRM and Growth apps use. «بازگشت» leads out to
 * wherever apps are launched from so the member is never trapped inside.
 */

import Link from "next/link";
import {
  LayoutDashboardIcon,
  PlugIcon,
  ShoppingBagIcon,
  ReceiptTextIcon,
  ContactIcon,
  FolderTreeIcon,
  FileTextIcon,
  ImageIcon,
  SendIcon,
} from "lucide-react";
import {
  SidebarContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import type { AppShellNavProps } from "../app-shell-nav";
import { APP_NAV_BUTTON_CLASS } from "../sidebar-nav-styles";
import { wpNavItemsForRole } from "./wp-nav";
import { wpSectionHref, isWpSectionPathname, type WpSectionKey } from "./wp-routes";

const SECTION_ICONS: Record<WpSectionKey, typeof LayoutDashboardIcon> = {
  overview: LayoutDashboardIcon,
  connections: PlugIcon,
  products: ShoppingBagIcon,
  orders: ReceiptTextIcon,
  customers: ContactIcon,
  taxonomies: FolderTreeIcon,
  content: FileTextIcon,
  media: ImageIcon,
  queue: SendIcon,
};

export function WpAppNav({ shell, role, pathname, onNavigate, workspaceShell }: AppShellNavProps) {
  const items = wpNavItemsForRole(role);
  const backHref = workspaceShell ? "/dashboard" : "/dashboard/overview";
  const backLabel = workspaceShell ? "بازگشت به میز کار" : "بازگشت به داشبورد";

  return (
    <SidebarContent className="px-3 py-4">
      <nav aria-label="بخش‌های مدیریت وردپرس" className="space-y-3">
        <div className="px-2 group-data-[state=collapsed]/sidebar:hidden">
          <p className="text-sm font-bold text-foreground">{shell.label}</p>
          <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground">{shell.description}</p>
        </div>

        <SidebarMenu className="space-y-1.5">
          {items.map((item) => {
            const active = isWpSectionPathname(pathname, item.key);
            const Icon = SECTION_ICONS[item.key];
            return (
              <SidebarMenuItem key={item.key}>
                <SidebarMenuButton
                  asChild
                  isActive={active}
                  tooltip={item.label}
                  className={APP_NAV_BUTTON_CLASS}
                >
                  <Link href={wpSectionHref(item.key)} onClick={onNavigate} aria-current={active ? "page" : undefined}>
                    <Icon className="size-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>

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
