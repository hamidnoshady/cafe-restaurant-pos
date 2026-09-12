"use client";

/**
 * The Accounting app's own main sidebar.
 *
 * Accounting was the last app without one. Its sections lived as a collapsible
 * «حسابداری» group inside the business's flat nav, so an accountant working in
 * the ledger saw the whole business menu — orders, menu, devices — with their
 * own app folded into a corner of it, while CRM, Growth and Websites each got
 * a menu of their own. The sections are unchanged: this reads the very same
 * `accounting-nav.ts` list, filtered by the very same role gate, so the app's
 * contents cannot drift from what the pages allow.
 *
 * Grouped, because the flat list is twenty-plus rows: an unbroken column of
 * that length is a list nobody scans. The groups are the accountant's own
 * division of the work — the ledger itself, who owes whom, cash movement,
 * setup — and every section appears in exactly one of them, asserted in
 * `accounting-nav.test.ts` so a new section cannot quietly go missing from the
 * menu.
 */

import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import {
  SidebarContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import type { AppShellNavProps } from "@/app/dashboard/app-shell-nav";
import {
  APP_NAV_BUTTON_CLASS,
  BACK_TO_WORKSPACE_BUTTON_CLASS,
} from "@/app/dashboard/sidebar-nav-styles";
import { ACCOUNTING_NAV_GROUPS, accountingSectionsForRole } from "./accounting-nav";
import { ACCOUNTING_SECTION_ICONS } from "./accounting-icons";
import { accountingSectionHref, isAccountingSectionPathname } from "./accounting-routes";

export function AccountingAppNav({
  shell,
  role,
  pathname,
  onNavigate,
  workspaceShell,
}: AppShellNavProps) {
  const allowed = accountingSectionsForRole(role);
  const byKey = new Map(allowed.map((section) => [section.key, section]));

  const backHref = workspaceShell ? "/dashboard" : "/dashboard/overview";
  const backLabel = workspaceShell ? "بازگشت به میز کار" : "بازگشت به داشبورد";

  return (
    <SidebarContent className="px-3 py-4">
      <nav aria-label="بخش‌های حسابداری" className="space-y-3">
        <div className="px-2 group-data-[state=collapsed]/sidebar:hidden">
          <p className="text-sm font-bold text-foreground">{shell.label}</p>
          <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground">{shell.description}</p>
        </div>

        {/* The way out, first — a control, not another section. */}
        <SidebarMenu className="space-y-1.5">
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip={backLabel} className={BACK_TO_WORKSPACE_BUTTON_CLASS}>
              <Link href={backHref} onClick={onNavigate}>
                <ArrowRightIcon aria-hidden="true" className="size-5 shrink-0 rtl:rotate-180" />
                <span className="min-w-0 flex-1 truncate text-start group-data-[state=collapsed]/sidebar:hidden">
                  {backLabel}
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div aria-hidden="true" className="border-t border-border/80" />

        {ACCOUNTING_NAV_GROUPS.map((group) => {
          const items = group.keys.flatMap((key) => {
            const section = byKey.get(key);
            return section ? [section] : [];
          });
          if (items.length === 0) return null;

          return (
            <div key={group.label} className="space-y-1.5">
              {/* Collapsed to a rail the headings are hidden, so a rule keeps
                  the groups from reading as one undivided column of glyphs. */}
              <div
                aria-hidden="true"
                className="mx-2 hidden border-t border-border/70 group-data-[state=collapsed]/sidebar:block"
              />
              <p className="px-2 text-[11px] font-bold text-muted-foreground group-data-[state=collapsed]/sidebar:hidden">
                {group.label}
              </p>
              <SidebarMenu className="space-y-1.5">
                {items.map((section) => {
                  const active = isAccountingSectionPathname(pathname, section.key);
                  const Icon = ACCOUNTING_SECTION_ICONS[section.key];
                  return (
                    <SidebarMenuItem key={section.key}>
                      <SidebarMenuButton
                        asChild
                        isActive={active}
                        tooltip={section.label}
                        className={APP_NAV_BUTTON_CLASS}
                      >
                        <Link
                          href={accountingSectionHref(section.key)}
                          onClick={onNavigate}
                          aria-current={active ? "page" : undefined}
                        >
                          <Icon aria-hidden="true" className="size-5 shrink-0" />
                          <span className="min-w-0 flex-1 truncate text-start group-data-[state=collapsed]/sidebar:hidden">
                            {section.label}
                          </span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </div>
          );
        })}
      </nav>
    </SidebarContent>
  );
}
