export type DashboardSidebarPreference = "expanded" | "collapsed";
export type SidebarMode = DashboardSidebarPreference;

/**
 * Keeps the dashboard navigation available on every route and breakpoint.
 * POS uses the same responsive drawer on small screens and collapsed rail on desktop.
 */
export function resolveSidebarMode(
  _pathname: string,
  preference: DashboardSidebarPreference,
): SidebarMode {
  return preference;
}

export function toggleDashboardSidebarPreference(
  preference: DashboardSidebarPreference,
): DashboardSidebarPreference {
  return preference === "expanded" ? "collapsed" : "expanded";
}
