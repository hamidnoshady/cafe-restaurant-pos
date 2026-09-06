"use client";

/**
 * Which component fills the sidebar slot for an app that owns one.
 *
 * `src/lib/app-shells.ts` says *when* an app owns the dashboard's main sidebar —
 * the route prefix it lives under, its name, its one line of description. The
 * *menu* itself belongs to the app, so it is registered here rather than spelled
 * out in `dashboard-sidebar.tsx`: the shell asks for the app's nav component and
 * renders it in the same slot the business nav uses, between the brand and the
 * member footer. An app that is not registered here keeps the business nav,
 * which is why حسابداری is absent from this map — it is the shape of the main
 * product, not a product of its own.
 *
 * The props are the same for every shell: the def that owns the slot (so an app
 * labels itself from the registry rather than restating its name in a component),
 * the member's role (so a component can show the sections that role may open),
 * the pathname (active state), a `onNavigate` to close the drawer on a phone,
 * and whether the workspace shell is on (which decides where «بازگشت» leads).
 */

import type { AppKey } from "@/lib/apps";
import type { AppShellDef } from "@/lib/app-shells";
import { CrmAppNav } from "./crm/crm-app-nav";
import { GrowthAppNav } from "./growth/growth-app-nav";
import { WebsiteAppNav } from "./website/website-app-nav";

export interface AppShellNavProps {
  /** The shell that owns this route — its label and description head the menu. */
  shell: AppShellDef;
  role: string;
  pathname: string;
  /** Closes the mobile drawer after a tap, the way the flat nav does. */
  onNavigate: () => void;
  /** The `workspace` feature flag: the rail launcher exists, so «بازگشت» goes to it. */
  workspaceShell: boolean;
}

export const APP_SHELL_NAV: Partial<
  Record<AppKey, (props: AppShellNavProps) => React.ReactElement>
> = {
  crm: CrmAppNav,
  growth: GrowthAppNav,
  website: WebsiteAppNav,
};

/** The nav component that owns the sidebar slot for an app, if it has one. */
export function appShellNavFor(app: AppKey | null | undefined) {
  return app ? APP_SHELL_NAV[app] : undefined;
}
