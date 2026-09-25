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

import { SidebarContent } from "@/components/ui/sidebar";
import type { AppShellNavProps } from "@/app/dashboard/app-shell-nav";
import { BackToWorkspaceMenu } from "@/app/dashboard/app-section-nav";
import { useOpenNavGroups } from "@/app/dashboard/use-open-nav-groups";
import { NavCollapsibleGroup, NavGroup } from "@/app/dashboard/sidebar-nav-group";
import {
  accountingWorkspaceGroups,
  LEDGER_WORKSPACE_GROUP_KEY,
  workspaceEntryIsActive,
  type WorkspaceNavEntry,
} from "./accounting-workspace";

/** Which groups the member left open, remembered per device like the flat nav's. */
const OPEN_GROUPS_KEY = "accounting-nav-open-groups";

export function AccountingAppNav({
  permissions,
  pathname,
  search = "",
  navItems = [],
  onNavigate,
}: AppShellNavProps) {
  const groups = accountingWorkspaceGroups({ permissions: new Set(permissions), navItems });

  const inLedger = groups
    .find((group) => group.key === LEDGER_WORKSPACE_GROUP_KEY)
    ?.entries.some((entry) => workspaceEntryIsActive(entry, pathname, search));
  const { toggleGroup, isOpen } = useOpenNavGroups(OPEN_GROUPS_KEY);

  return (
    <SidebarContent className="px-3 py-4">
      <nav aria-label="منوی حسابداری" className="space-y-3">
        <BackToWorkspaceMenu onNavigate={onNavigate} />

        {groups.map((group) => {
          if (group.entries.length === 0) return null;
          const isActive = (entry: WorkspaceNavEntry) => workspaceEntryIsActive(entry, pathname, search);

          if (group.collapsible) {
            const open = isOpen(group.key, Boolean(inLedger));
            return (
              <NavCollapsibleGroup
                key={group.key}
                group={group}
                idPrefix="accounting-nav"
                isActive={isActive}
                onNavigate={onNavigate}
                open={open}
                onToggle={() => toggleGroup(group.key, open)}
              />
            );
          }

          return <NavGroup key={group.key} group={group} isActive={isActive} onNavigate={onNavigate} />;
        })}
      </nav>
    </SidebarContent>
  );
}
