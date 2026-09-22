import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  getWorkspaceProject,
  listActivity,
  listMembers,
  listPhases,
  requireProjectCapability,
  updateWorkspaceProject,
} from "@/lib/workspace";
import { PERMISSIONS, handleWorkspaceError, readBody, workspaceOwner } from "../../guard";

/**
 * GET   — one project with everything its page needs: phases, members, activity.
 * PATCH — amend the project record.
 *
 * Both run the per-project capability check on top of the platform permission:
 * holding `workspace.view` means "may use the workspace", not "may read every
 * project in it". `privileged` is passed for a holder of `workspace.manage`,
 * who is the business's own manager and must not be locked out of a project
 * nobody remembered to add them to.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      const role = await requireProjectCapability(owner, id, "view", true);
      const [project, phases, members, activity] = await Promise.all([
        getWorkspaceProject(owner.businessId, id),
        listPhases(id),
        listMembers(id),
        listActivity(owner.businessId, { projectId: id, limit: 20 }),
      ]);
      if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
      return NextResponse.json({ project, phases, members, activity, role });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);

export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    const body = await readBody(request);
    try {
      await requireProjectCapability(owner, id, "manage", true);
      const project = await updateWorkspaceProject(owner, id, body);
      if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
      return NextResponse.json({ project });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);
