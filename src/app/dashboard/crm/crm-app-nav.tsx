"use client";

/**
 * The CRM app's own main sidebar (Phase 36).
 *
 * Rendered in the dashboard's app slot for every route under `/dashboard/crm` —
 * `src/lib/app-shells.ts` is the rule that hands the slot over. Structurally
 * identical to the Growth app's nav on purpose: two apps in the same platform
 * whose menus behaved differently would be two products, and the shared
 * `AppShellNavProps` contract is what keeps the shell from knowing anything
 * about either app.
 *
 * «بازگشت» leads out to wherever apps are launched from — the workspace rail
 * when that shell is on, the classic dashboard otherwise — so owning the
 * sidebar never means trapping the member inside the app.
 */

import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import {
  SidebarContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import type { AppShellNavProps } from "../app-shell-nav";
import { APP_NAV_BUTTON_CLASS } from "../sidebar-nav-styles";
import { crmNavItemsForRole } from "./crm-nav";
import { crmSectionHref, isCrmSectionPathname } from "./crm-routes";

export function CrmAppNav({ shell, role, pathname, onNavigate, workspaceShell }: AppShellNavProps) {
  const items = crmNavItemsForRole(role);
  const backHref = workspaceShell ? "/dashboard" : "/dashboard/overview";
  const backLabel = workspaceShell ? "بازگشت به میز کار" : "بازگشت به داشبورد";

  return (
    <SidebarContent className="px-3 py-4">
      <nav aria-label="بخش‌های ارتباط با مشتری" className="space-y-3">
        <div className="px-2 group-data-[state=collapsed]/sidebar:hidden">
          <p className="text-sm font-bold text-stone-950">{shell.label}</p>
          <p className="mt-0.5 text-[11px] leading-5 text-stone-500">{shell.description}</p>
        </div>

        <SidebarMenu className="space-y-1.5">
          {items.map((item) => {
            const active = isCrmSectionPathname(pathname, item.key);
            const Icon = item.icon;
            return (
              <SidebarMenuItem key={item.key}>
                <SidebarMenuButton
                  asChild
                  isActive={active}
                  tooltip={item.label}
                  className={APP_NAV_BUTTON_CLASS}
                >
                  <Link
                    href={crmSectionHref(item.key)}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                  >
                    <Icon aria-hidden="true" className="size-5 shrink-0" />
                    <span className="min-w-0 flex-1 text-right group-data-[state=collapsed]/sidebar:hidden">
                      <span className="block truncate">{item.label}</span>
                      <span className="block truncate text-[11px] font-normal leading-4 text-stone-500">
                        {item.description}
                      </span>
                    </span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>

        <SidebarMenu className="space-y-1.5 border-t border-stone-200/80 pt-3">
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              tooltip={backLabel}
              className="min-h-12 rounded-xl text-stone-600 hover:bg-stone-50 hover:text-stone-950"
            >
              <Link href={backHref} onClick={onNavigate}>
                <ArrowRightIcon aria-hidden="true" className="size-5 shrink-0 rtl:rotate-180" />
                <span className="group-data-[state=collapsed]/sidebar:hidden">{backLabel}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </nav>
    </SidebarContent>
  );
}
