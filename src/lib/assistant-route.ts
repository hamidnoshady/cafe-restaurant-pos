/**
 * Whether a dashboard path is an AI-assistant *chat* surface.
 *
 * Two routes host the assistant's full-page chat: `/ai` (its own page) and the
 * workspace chat home `/dashboard` when the `workspace` feature is on. On these
 * the assistant owns the whole viewport — its own navigation and a pinned
 * composer — so the dashboard's global chrome (the customizable mobile bottom
 * bar, the padded scroller, the header) stands aside.
 *
 * The AI Workspace's *management* sections (Phase I) — `/ai/coworkers`,
 * `/ai/automations`, `/ai/activity` — are ordinary scrolling pages, NOT the
 * pinned-composer chat surface, so they are deliberately excluded: only the
 * exact chat root matches, not every `/ai/*` path. A page mounted under `/ai`
 * that wants the full-height chat layout must be the chat root itself.
 *
 * Keeping the test in one place matters: the sidebar hides the mobile bottom
 * bar here, `DashboardMain` switches to the full-height layout here, and if the
 * two ever disagreed the composer would sit under a bar again.
 */
export function isAssistantSurface(pathname: string, workspaceEnabled: boolean): boolean {
  return pathname === "/ai" || (workspaceEnabled && pathname === "/dashboard");
}
