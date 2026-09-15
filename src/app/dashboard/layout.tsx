import { WorkspaceShell } from "./workspace-shell";

/**
 * `/dashboard` — the workspace home, the one page left under this prefix.
 *
 * Every other page moved out: the apps (`/accounting`, `/growth`, `/crm`,
 * `/websites`, `/projects`, `/settings`) and the workspace's own pages
 * (`/overview`, `/ai`, `/media`, `/knowledge`, `/support`) are real routes
 * under `src/app/(app)` and render the very same shell from their own layout.
 * The old `/dashboard/<page>` addresses 308-redirect in middleware
 * (`src/lib/app-routes.ts`), so no bookmark ever 404s. The component modules
 * beside this file stay here as the shared workspace chrome and page bodies.
 */
export default function DashboardLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <WorkspaceShell>{children}</WorkspaceShell>;
}
