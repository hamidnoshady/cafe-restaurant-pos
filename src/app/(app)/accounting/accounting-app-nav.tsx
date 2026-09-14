"use client";

/**
 * The Accounting workspace's main sidebar.
 *
 * Accounting is the business's *primary* workspace, so this is the complete
 * work menu: the business's own areas — فروش و فاکتور، خرید و انبار،
 * محصولات، عملیات صنف، گزارش‌ها، تنظیمات — plus the ledger, gathered into one
 * named group called «فضای کار حسابداری». Before this, opening «حسابداری»
 * dropped straight into that ledger group and nothing else, and everything a
 * business does daily lived in a second main menu at `/dashboard/*`: two
 * competing navigations, with the one named after the app being the narrower.
 *
 * Nothing here is a new page or a second copy of one. The business entries are
 * picked out of the nav the shell already built and already filtered for this
 * member's trade, role, features and permissions
 * (`accounting-workspace.ts`), so a page this member cannot open is simply not
 * in the list — one gate, not two that could disagree. The ledger entries are
 * the same `accounting-nav.ts` sections behind the same role check the pages
 * use.
 *
 * Every group — plain or collapsible — is drawn by the shared
 * `sidebar-nav-group.tsx`, so «فضای کار حسابداری» wears the design system's
 * nav skin (a 48px `rounded-xl` amber row with an icon, a label and a
 * chevron) instead of the small bespoke caption-with-an-arrow it used to be,
 * and it carries named sub-groups the way every other group carries a
 * heading.
 *
 * RTL: every inset is logical (`ms`/`me`, `border-s`, `text-start`), the
 * disclosure chevron points down when open and toward the inline start when
 * closed, and the groups are real disclosures over real `<ul>`s so a screen
 * reader hears the same structure the eye sees.
 */

import { useEffect, useState } from "react";
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
  BACK_TO_WORKSPACE_BUTTON_CLASS,
  NAV_LABEL_CLASS,
} from "@/app/dashboard/sidebar-nav-styles";
import { NavCollapsibleGroup, NavGroup } from "@/app/dashboard/sidebar-nav-group";
import { isAccountingSectionPathname } from "./accounting-routes";
import {
  accountingWorkspaceGroups,
  LEDGER_WORKSPACE_GROUP_KEY,
  type WorkspaceNavEntry,
} from "./accounting-workspace";

/** Which groups the member left open, remembered per device like the flat nav's. */
const OPEN_GROUPS_KEY = "accounting-nav-open-groups";

/**
 * Is this entry the page we are on?
 *
 * Two rules, because the menu holds two kinds of entry. An accounting section
 * is matched by its section key (so `/accounting/directory?view=customers`
 * lights «اشخاص» and its «مشتریان» deep link both). A business page is matched
 * by path prefix, the way the flat nav matches — and exactly, for the roots
 * (`/settings`, `/dashboard/products`) that would otherwise swallow every page
 * beneath them.
 */
function entryIsActive(entry: WorkspaceNavEntry, pathname: string, search: string): boolean {
  if (entry.section) {
    if (!isAccountingSectionPathname(pathname, entry.section)) return false;
    const view = new URLSearchParams(entry.href.split("?")[1] ?? "").get("view");
    const current = new URLSearchParams(search).get("view");
    // A deep link into a view is only "here" when that view is showing; the
    // parent «اشخاص» entry owns the default list.
    return view ? current === view : !current;
  }
  const base = entry.href.split("?")[0];
  return pathname === base || pathname.startsWith(`${base}/`);
}

export function AccountingAppNav({
  role,
  pathname,
  search = "",
  navItems = [],
  onNavigate,
  workspaceShell,
}: AppShellNavProps) {
  const groups = accountingWorkspaceGroups({ role, navItems });

  const inLedger = groups
    .find((group) => group.key === LEDGER_WORKSPACE_GROUP_KEY)
    ?.entries.some((entry) => entryIsActive(entry, pathname, search));
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(OPEN_GROUPS_KEY);
      if (raw) setOpenGroups(JSON.parse(raw) as Record<string, boolean>);
    } catch {
      // A hand-edited or quota-broken store is a preference, not an error.
    }
    setRestored(true);
  }, []);

  function toggle(key: string, currentlyOpen: boolean) {
    setOpenGroups((current) => {
      const next = { ...current, [key]: !currentlyOpen };
      try {
        window.localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify(next));
      } catch {
        // Same again: failing to remember is not failing to navigate.
      }
      return next;
    });
  }

  const backHref = "/dashboard";
  const backLabel = "بازگشت به میز کار";

  return (
    <SidebarContent className="px-3 py-4">
      <nav aria-label="منوی حسابداری" className="space-y-3">
        {workspaceShell ? (
          <>
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
          </>
        ) : null}

        {groups.map((group) => {
          if (group.entries.length === 0) return null;
          const isActive = (entry: WorkspaceNavEntry) => entryIsActive(entry, pathname, search);

          if (group.collapsible) {
            const open = restored ? (openGroups[group.key] ?? Boolean(inLedger)) : Boolean(inLedger);
            return (
              <NavCollapsibleGroup
                key={group.key}
                group={group}
                idPrefix="accounting-nav"
                isActive={isActive}
                onNavigate={onNavigate}
                open={open}
                onToggle={() => toggle(group.key, open)}
              />
            );
          }

          return <NavGroup key={group.key} group={group} isActive={isActive} onNavigate={onNavigate} />;
        })}
      </nav>
    </SidebarContent>
  );
}
