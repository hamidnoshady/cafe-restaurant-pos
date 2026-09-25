"use client";

/**
 * Which component fills the sidebar slot for an app that owns one.
 *
 * `src/lib/app-shells.ts` says *when* an app owns the dashboard's main sidebar —
 * the route prefix it lives under, its name, its one line of description. The
 * *menu* itself belongs to the app, so it is registered here rather than spelled
 * out in `dashboard-sidebar.tsx`: the shell asks for the app's nav component and
 * renders it in the same slot the business nav uses, between the brand and the
 * member footer. An app that is not registered here keeps the business nav.
 *
 * حسابداری is registered like the rest now. It used to be the exception — "the
 * shape of the main product, not a product of its own" — but with every app on
 * its own public prefix that exception only meant one app whose sections were
 * scattered through the business menu while its peers had menus of their own.
 *
 * The props are the same for every shell: the def that owns the slot (so an app
 * labels itself from the registry rather than restating its name in a component),
 * the member's role (so a component can show the sections that role may open),
 * the pathname (active state), and a `onNavigate` to close the drawer on a
 * phone. «بازگشت» always leads back to the workspace home — `/dashboard` is
 * that home for every business now.
 */

import type { AppKey } from "@/lib/apps";
import type { AppShellDef } from "@/lib/app-shells";
import { AccountingAppNav } from "@/app/(app)/accounting/accounting-app-nav";
import { CrmAppNav } from "@/app/(app)/crm/crm-app-nav";
import { GrowthAppNav } from "@/app/(app)/growth/growth-app-nav";
import { WebsiteAppNav } from "@/app/(app)/websites/website-app-nav";

export interface AppShellNavProps {
  /** The shell that owns this route — its label and description head the menu. */
  shell: AppShellDef;
  role: string;
  permissions: readonly string[];
  pathname: string;
  /**
   * The current query string (without `?`).
   *
   * Only the Accounting workspace reads it so far: its directory entries are
   * one route with a `?view=` filter, and «مشتریان» must not light up while
   * «همه اشخاص» is showing.
   */
  search?: string;
  /**
   * The business nav the shell built — already filtered for this member's
   * trade, role, features and permissions, and flattened so children are
   * reachable too.
   *
   * An app whose menu adopts business pages (Accounting, which is the
   * business's primary workspace) arranges *these* entries rather than
   * declaring its own: one gate, so a page the member cannot open can never
   * appear in an app's menu.
   */
  navItems?: readonly { label: string; href: string; iconKey?: string }[];
  /** Closes the mobile drawer after a tap, the way the flat nav does. */
  onNavigate: () => void;
}

export const APP_SHELL_NAV: Partial<
  Record<AppKey, (props: AppShellNavProps) => React.ReactElement>
> = {
  accounting: AccountingAppNav,
  crm: CrmAppNav,
  growth: GrowthAppNav,
  website: WebsiteAppNav,
};

/** The nav component that owns the sidebar slot for an app, if it has one. */
export function appShellNavFor(app: AppKey | null | undefined) {
  return app ? APP_SHELL_NAV[app] : undefined;
}
