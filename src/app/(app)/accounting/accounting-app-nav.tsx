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
 * RTL: every inset is logical (`ms`/`me`, `border-s`, `text-start`), the
 * disclosure chevron points down when open and toward the inline start when
 * closed, and the group headings are real `<h2>`s over real `<ul>`s so a
 * screen reader hears the same structure the eye sees.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRightIcon, ChevronDownIcon, CircleIcon } from "lucide-react";
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
  NAV_LABEL_CLASS,
} from "@/app/dashboard/sidebar-nav-styles";
import { NAV_ICONS } from "@/app/dashboard/sidebar-nav-icons";
import { ACCOUNTING_SECTION_ICONS } from "./accounting-icons";
import { isAccountingSectionPathname } from "./accounting-routes";
import {
  accountingWorkspaceGroups,
  LEDGER_WORKSPACE_GROUP_KEY,
  type WorkspaceNavEntry,
  type WorkspaceNavGroup,
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

function EntryIcon({ entry }: { entry: WorkspaceNavEntry }) {
  const Icon = entry.section
    ? ACCOUNTING_SECTION_ICONS[entry.section]
    : (NAV_ICONS[entry.iconKey ?? entry.href] ?? NAV_ICONS[entry.href.split("?")[0]] ?? CircleIcon);
  return <Icon aria-hidden="true" className="size-5 shrink-0" />;
}

function NavEntries({
  entries,
  pathname,
  search,
  onNavigate,
  indented,
}: {
  entries: readonly WorkspaceNavEntry[];
  pathname: string;
  search: string;
  onNavigate: () => void;
  /** Inside a disclosure group: a start-side rule ties the children to their heading. */
  indented?: boolean;
}) {
  return (
    <SidebarMenu
      className={
        indented
          ? "ms-4 space-y-1.5 border-s border-border/70 ps-2 group-data-[state=collapsed]/sidebar:ms-0 group-data-[state=collapsed]/sidebar:border-s-0 group-data-[state=collapsed]/sidebar:ps-0"
          : "space-y-1.5"
      }
    >
      {entries.map((entry) => {
        const active = entryIsActive(entry, pathname, search);
        return (
          <SidebarMenuItem key={entry.href}>
            <SidebarMenuButton asChild isActive={active} tooltip={entry.label} className={APP_NAV_BUTTON_CLASS}>
              <Link href={entry.href} onClick={onNavigate} aria-current={active ? "page" : undefined}>
                <EntryIcon entry={entry} />
                <span className={NAV_LABEL_CLASS}>{entry.label}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}

function CollapsibleGroup({
  group,
  pathname,
  search,
  onNavigate,
  open,
  onToggle,
}: {
  group: WorkspaceNavGroup;
  pathname: string;
  search: string;
  onNavigate: () => void;
  open: boolean;
  onToggle: () => void;
}) {
  const panelId = `accounting-nav-${group.key}`;
  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex min-h-10 w-full items-center gap-2 rounded-xl px-2 text-start text-[11px] font-bold text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 group-data-[state=collapsed]/sidebar:hidden"
      >
        <ChevronDownIcon
          aria-hidden="true"
          // Closed, the chevron points toward the inline start — which in this
          // RTL product is the left, hence the extra flip under `rtl:`.
          className={`size-4 shrink-0 transition-transform ${open ? "" : "-rotate-90 rtl:rotate-90"}`}
        />
        <span className="min-w-0 flex-1 truncate">{group.label}</span>
      </button>
      <div id={panelId} hidden={!open}>
        {group.description ? (
          <p className="mb-1.5 px-2 text-[11px] leading-5 text-muted-foreground group-data-[state=collapsed]/sidebar:hidden">
            {group.description}
          </p>
        ) : null}
        <NavEntries entries={group.entries} pathname={pathname} search={search} onNavigate={onNavigate} indented />
      </div>
    </div>
  );
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

          if (group.collapsible) {
            const open = restored ? (openGroups[group.key] ?? Boolean(inLedger)) : Boolean(inLedger);
            return (
              <CollapsibleGroup
                key={group.key}
                group={group}
                pathname={pathname}
                search={search}
                onNavigate={onNavigate}
                open={open}
                onToggle={() => toggle(group.key, open)}
              />
            );
          }

          return (
            <div key={group.key} className="space-y-1.5">
              <div
                aria-hidden="true"
                className="mx-2 hidden border-t border-border/70 group-data-[state=collapsed]/sidebar:block"
              />
              <p className="px-2 text-[11px] font-bold text-muted-foreground group-data-[state=collapsed]/sidebar:hidden">
                {group.label}
              </p>
              <NavEntries
                entries={group.entries}
                pathname={pathname}
                search={search}
                onNavigate={onNavigate}
              />
            </div>
          );
        })}
      </nav>
    </SidebarContent>
  );
}
