/**
 * Whether a dashboard path is the AI-assistant *chat* surface.
 *
 * Exactly one route hosts the assistant: `/dashboard`, the chat home — the
 * assistant is the dashboard itself. On it the assistant owns the whole
 * viewport (its own navigation and a pinned composer), so the dashboard's
 * global chrome (the customizable mobile bottom bar, the padded scroller)
 * stands aside.
 *
 * The assistant's *management* panel is a drawer over that same page, not a
 * route of its own: the old `/ai` application and its section pages are
 * compatibility redirects to `/dashboard` (see `legacyAssistantTarget` in
 * `app-routes.ts`), so no `/ai/*` path is ever a chat surface, and a
 * `?aiPanel=` query never changes the answer either — the chat stays
 * full-height underneath the open drawer.
 *
 * Keeping the test in one place matters: the sidebar hides the mobile bottom
 * bar here, `DashboardMain` switches to the full-height layout here, and if
 * the two ever disagreed the composer would sit under a bar again.
 */
export function isAssistantSurface(pathname: string): boolean {
  return pathname === "/dashboard";
}
