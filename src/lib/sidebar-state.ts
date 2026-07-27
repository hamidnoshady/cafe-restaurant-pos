export type DashboardSidebarPreference = "expanded" | "collapsed";
export type SidebarMode = DashboardSidebarPreference | "offcanvas";

export function resolveSidebarMode(
  pathname: string,
  preference: DashboardSidebarPreference,
): SidebarMode {
  return pathname === "/dashboard/pos" || pathname.startsWith("/dashboard/pos/")
    ? "offcanvas"
    : preference;
}

export function toggleDashboardSidebarPreference(
  preference: DashboardSidebarPreference,
): DashboardSidebarPreference {
  return preference === "expanded" ? "collapsed" : "expanded";
}
