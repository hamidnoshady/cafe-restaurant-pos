import { WorkspaceShell } from "../dashboard/workspace-shell";

/**
 * The platform's public app URLs — `/accounting`, `/growth`, `/crm`,
 * `/websites`, `/projects` and `/settings`.
 *
 * A route group (the `(app)` folder contributes no path segment), so each app
 * owns a top-level URL of its own while sharing the one workspace chrome with
 * `/dashboard/*`. Nothing is rewritten: the address bar, the server's route
 * resolution and the client router all agree on the same pathname, which is
 * what the previous middleware rewrite could not guarantee.
 */
export default function AppRoutesLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <WorkspaceShell>{children}</WorkspaceShell>;
}
