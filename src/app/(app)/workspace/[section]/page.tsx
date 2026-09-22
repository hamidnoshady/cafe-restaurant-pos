import { redirect } from "next/navigation";
import { WORKSPACE_MODULE_HOME } from "@/lib/app-routes";
import { WorkspacePageBody } from "../workspace-page-body";
import { isWorkspaceSection } from "../workspace-routes";

/**
 * One workspace section per URL — `/workspace/tasks`, `/workspace/contracts`.
 *
 * Every section renders the same body, so there is nothing section-specific
 * about the page beyond the key it hands down. Two deliberate behaviours:
 *
 *  - `projects` is a real sibling directory (it has a `[id]` child for a
 *    project's own page), so it never reaches here;
 *  - an unknown section goes to the module home, not to a 404. A retired or
 *    mistyped workspace link should still land somebody in their workspace.
 */
export default async function WorkspaceSectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  if (!isWorkspaceSection(section)) redirect(WORKSPACE_MODULE_HOME);
  return <WorkspacePageBody section={section} />;
}
