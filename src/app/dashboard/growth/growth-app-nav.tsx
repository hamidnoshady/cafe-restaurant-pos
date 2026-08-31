"use client";

/**
 * The Growth app's own main sidebar (Phase 36b, revised again).
 *
 * Rendered in the dashboard's app slot for every route under
 * `/dashboard/growth` — `src/lib/app-shells.ts` is the rule that hands the slot
 * over. Three things change for the app here:
 *
 * - its sections are the *main* menu, at the level the business's own pages sit
 *   at, instead of a second menu drawn inside the page (a sub-menu of a page,
 *   which read as one folder of accounting);
 * - nothing from حسابداری or the rest of the business is listed, because the
 *   app is a separate product, not a corner of the ledger — the way the
 *   business's flat nav no longer lists «رشد و بازاریابی» either, so each menu
 *   has one answer to "where am I";
 * - «میز کار» is the way out, to the workspace home where the apps are launched
 *   from (the dashboard itself where the workspace shell is off), so owning a
 *   sidebar does not mean trapping the member in it.
 *
 * The entries come from `growth-nav.ts` and are filtered by the app's own role
 * gate, so a cashier's sidebar holds the one section they may open — exactly
 * what the page redirects already assume.
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
import { growthNavItemsForRole } from "./growth-nav";
import { growthSectionHref, isGrowthSectionPathname } from "./growth-routes";

export function GrowthAppNav({
  shell,
  role,
  pathname,
  onNavigate,
  workspaceShell,
}: AppShellNavProps) {
  const items = growthNavItemsForRole(role);
  // The workspace shell launches apps from the rail on the chat home, so that is
  // «back»; without it, /dashboard is the legacy dashboard and /dashboard/overview
  // is the page the nav calls «داشبورد». Losing the app's own menu is never an
  // option, so this is the only exit the sidebar offers.
  const backHref = workspaceShell ? "/dashboard" : "/dashboard/overview";
  const backLabel = workspaceShell ? "بازگشت به میز کار" : "بازگشت به داشبورد";

  return (
    <SidebarContent className="px-3 py-4">
      <nav aria-label="بخش‌های رشد و بازاریابی" className="space-y-3">
        <div className="px-2 group-data-[state=collapsed]/sidebar:hidden">
          <p className="text-sm font-bold text-foreground">{shell.label}</p>
          <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground">{shell.description}</p>
        </div>

        <SidebarMenu className="space-y-1.5">
          {items.map((item) => {
            const active = isGrowthSectionPathname(pathname, item.key);
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
                    href={growthSectionHref(item.key)}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                  >
                    <Icon aria-hidden="true" className="size-5 shrink-0" />
                    <span className="min-w-0 flex-1 text-right group-data-[state=collapsed]/sidebar:hidden">
                      <span className="block truncate">{item.label}</span>
                      <span className="block truncate text-[11px] font-normal leading-4 text-muted-foreground">
                        {item.description}
                      </span>
                    </span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>

        <SidebarMenu className="space-y-1.5 border-t border-border/80 pt-3">
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              tooltip={backLabel}
              className="min-h-12 rounded-xl text-muted-foreground hover:bg-muted hover:text-foreground"
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
