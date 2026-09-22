import { WorkspacePageBody } from "../workspace-page-body";

/**
 * `/workspace/projects` — the projects register.
 *
 * A static route rather than a match of `[section]` because this section owns
 * a child route (`/workspace/projects/<id>`, one project's own page) and a
 * dynamic segment cannot have a differently-shaped child beneath it. This is
 * also where every `/projects` and `/dashboard/projects` bookmark lands, via
 * the middleware redirect table.
 */
export default async function WorkspaceProjectsPage() {
  return <WorkspacePageBody section="projects" />;
}
