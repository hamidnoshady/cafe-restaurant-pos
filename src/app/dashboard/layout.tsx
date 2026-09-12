import { WorkspaceShell } from "./workspace-shell";

/**
 * `/dashboard/*` — the business's own pages (POS, orders, reports, the
 * technical-connections hub, …) inside the shared workspace chrome.
 *
 * The chrome itself lives in `workspace-shell.tsx` because the platform's apps
 * are no longer nested under this route tree: `/accounting`, `/growth`,
 * `/crm`, `/websites`, `/projects` and `/settings` are real routes under
 * `src/app/(app)` and render the very same shell from their own layout.
 */
export default function DashboardLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <WorkspaceShell>{children}</WorkspaceShell>;
}
