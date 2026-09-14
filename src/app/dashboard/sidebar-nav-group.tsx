"use client";

/**
 * One group of entries in the dashboard's navigation column — plain or
 * collapsible — written once for every menu that draws one.
 *
 * Why it exists: «فضای کار حسابداری» was the one group in the Accounting menu
 * with a disclosure, and its disclosure was a bespoke 40px-tall, 11px-bold
 * heading with a chevron — a control that shared nothing with the 48px
 * `rounded-xl` amber rows underneath it. So the longest, most important group
 * in the menu read as a stray toggle rather than as part of the menu, and it
 * was the only group with no internal headings while every other group had
 * one. Both halves of that were the same bug: the group was hand-rolled, in
 * two places (`dashboard-sidebar.tsx` and `accounting-app-nav.tsx`) that had
 * already drifted apart by a `duration-200`.
 *
 * The rules it keeps (docs/design-system.md §Rail navigation, §Radius scale,
 * §Colour roles):
 *  - a group header is a **nav-sized control**: `min-h-12 rounded-xl px-3`,
 *    icon + label + chevron, the same `APP_NAV_BUTTON_CLASS` amber hover and
 *    selection skin its rows wear — amber is selection, everywhere;
 *  - a closed group whose current page is inside it stays marked as selected,
 *    so «you are here» survives collapsing;
 *  - group labels are the metadata style `text-[11px] font-semibold
 *    tracking-wide`, never a second spelling of it;
 *  - sub-group headings divide a long group the way every other group is
 *    divided by its own heading;
 *  - RTL throughout: logical insets only (`ms`/`ps`/`border-s`/`text-start`)
 *    and a chevron that points toward the inline start when closed;
 *  - at the 4rem icon rail the words hide and the rows stay reachable — a
 *    closed group must never leave the rail empty, because there is no
 *    chevron there to reopen it with.
 */

import Link from "next/link";
import { ChevronDownIcon, CircleIcon, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { NAV_ICONS } from "./sidebar-nav-icons";
import { APP_NAV_BUTTON_CLASS, NAV_LABEL_CLASS } from "./sidebar-nav-styles";
import type {
  WorkspaceNavEntry,
  WorkspaceNavGroup,
} from "@/app/(app)/accounting/accounting-workspace";
import { ACCOUNTING_SECTION_ICONS } from "@/app/(app)/accounting/accounting-icons";

/** The metadata type a group heading is written in — stated once. */
export const NAV_GROUP_LABEL_CLASS =
  "px-3 pb-1 pt-2 text-[11px] font-semibold tracking-wide text-muted-foreground group-data-[state=collapsed]/sidebar:hidden";

/**
 * The hairline that replaces a heading at the 4rem rail, where words are
 * hidden and two groups would otherwise read as one column of glyphs.
 */
export const NAV_GROUP_RULE_CLASS =
  "mx-2 hidden border-t border-border/70 group-data-[state=collapsed]/sidebar:block";

/**
 * The same metadata type one indent in, over a sub-group's rows — written out
 * rather than merged with the class above, because `ps-`/`px-` merging depends
 * on the merge strategy and a heading that silently lost its inset is exactly
 * the kind of drift this file exists to stop.
 */
export const NAV_SUBGROUP_LABEL_CLASS =
  "ms-4 ps-4 pb-1 pt-2 text-[11px] font-semibold tracking-wide text-muted-foreground group-data-[state=collapsed]/sidebar:hidden";

/** Whether an entry is the page currently open — each menu's own rule. */
export type EntryActiveTest = (entry: WorkspaceNavEntry) => boolean;

function EntryIcon({ entry }: { entry: WorkspaceNavEntry }) {
  const Icon = entry.section
    ? ACCOUNTING_SECTION_ICONS[entry.section]
    : (NAV_ICONS[entry.iconKey ?? entry.href] ?? NAV_ICONS[entry.href.split("?")[0]] ?? CircleIcon);
  return <Icon aria-hidden="true" className="size-5 shrink-0" />;
}

export function NavEntries({
  entries,
  isActive,
  onNavigate,
  indented,
}: {
  entries: readonly WorkspaceNavEntry[];
  isActive: EntryActiveTest;
  onNavigate: () => void;
  /** Inside a disclosure group: a start-side rule ties the children to their heading. */
  indented?: boolean;
}) {
  return (
    <SidebarMenu
      className={cn(
        "space-y-1.5",
        indented &&
          "ms-4 border-s border-border/70 ps-2 group-data-[state=collapsed]/sidebar:ms-0 group-data-[state=collapsed]/sidebar:border-s-0 group-data-[state=collapsed]/sidebar:ps-0",
      )}
    >
      {entries.map((entry) => {
        const active = isActive(entry);
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

/** A group that is simply open: a heading over its rows. */
export function NavGroup({
  group,
  isActive,
  onNavigate,
}: {
  group: WorkspaceNavGroup;
  isActive: EntryActiveTest;
  onNavigate: () => void;
}) {
  return (
    <div className="space-y-1.5">
      <div aria-hidden="true" className={NAV_GROUP_RULE_CLASS} />
      <p className={NAV_GROUP_LABEL_CLASS}>{group.label}</p>
      <NavEntries entries={group.entries} isActive={isActive} onNavigate={onNavigate} />
    </div>
  );
}

/**
 * A group that discloses — the long one.
 *
 * Its header is a real menu row (icon, label, chevron) rather than a caption
 * with an arrow, so it sits in the same column as everything it opens. When it
 * is closed over the page you are on it keeps the selected skin, and it says
 * so in words on the label's tooltip rather than only in colour.
 */
export function NavCollapsibleGroup({
  group,
  idPrefix,
  isActive,
  onNavigate,
  open,
  onToggle,
}: {
  group: WorkspaceNavGroup;
  /** Prefixes the panel id so two menus on one page cannot collide. */
  idPrefix: string;
  isActive: EntryActiveTest;
  onNavigate: () => void;
  open: boolean;
  onToggle: () => void;
}) {
  const panelId = `${idPrefix}-${group.key}`;
  const holdsCurrentPage = group.entries.some((entry) => isActive(entry));
  const GroupIcon = (group.iconKey ? NAV_ICONS[group.iconKey] : undefined) ?? CircleIcon;
  const subGroups = group.subGroups?.length
    ? group.subGroups
    : [{ key: group.key, label: "", entries: group.entries }];

  return (
    <div className="space-y-1.5">
      <div aria-hidden="true" className={NAV_GROUP_RULE_CLASS} />
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-controls={panelId}
            // Closed over the current page, the header is the only thing left
            // showing «you are here»; open, the row inside owns it.
            isActive={holdsCurrentPage && !open}
            className={cn(APP_NAV_BUTTON_CLASS, "font-semibold group-data-[state=collapsed]/sidebar:hidden")}
          >
            <GroupIcon aria-hidden="true" className="size-5 shrink-0" />
            <span className={NAV_LABEL_CLASS}>{group.label}</span>
            <ChevronDownIcon
              aria-hidden="true"
              // Closed, the chevron points toward the inline start — which in
              // this RTL product is the left, hence the extra flip under `rtl:`.
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-out group-data-[state=collapsed]/sidebar:hidden",
                open ? "" : "-rotate-90 rtl:rotate-90",
              )}
            />
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>

      {/*
        At the 4rem rail there is no chevron to reopen a closed group with, so
        a closed group would leave the rail simply empty. The disclosure is an
        expanded-rail affordance; collapsed, the rows are always listed.
      */}
      <div
        id={panelId}
        className={cn("space-y-1.5", open ? "" : "hidden group-data-[state=collapsed]/sidebar:block")}
      >
        {group.description ? (
          <p className="px-3 text-[11px] leading-5 text-muted-foreground group-data-[state=collapsed]/sidebar:hidden">
            {group.description}
          </p>
        ) : null}
        {subGroups.map((subGroup, index) => (
          <div key={subGroup.key} className="space-y-1.5">
            {subGroup.label ? (
              <>
                {/* The group's own rule already sits above the first one; a
                    second hairline there would draw a double line at 4rem,
                    where the header and the headings are hidden. */}
                {index > 0 ? <div aria-hidden="true" className={NAV_GROUP_RULE_CLASS} /> : null}
                <p className={NAV_SUBGROUP_LABEL_CLASS}>{subGroup.label}</p>
              </>
            ) : null}
            <NavEntries entries={subGroup.entries} isActive={isActive} onNavigate={onNavigate} indented />
          </div>
        ))}
      </div>
    </div>
  );
}
