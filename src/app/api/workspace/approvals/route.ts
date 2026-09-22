import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { listApprovals, requestApproval, type ApprovalListFilter } from "@/lib/workspace";
import type { WorkspaceApprovalStatus, WorkspaceApprovalSubject } from "@/lib/workspace-shared";
import { PERMISSIONS, handleWorkspaceError, readBody, workspaceOwner } from "../guard";

/**
 * GET  — the approval queue.
 * POST — REQUEST an approval. Requesting is ordinary workspace work
 *        (`workspace.manage`); DECIDING is `workspace.approve` and lives on
 *        `[id]`. Splitting them is the entire point of an approval gate — if
 *        the requester could also decide, the gate would be decorative.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView);
  if (error) return error;
  const params = new URL(request.url).searchParams;
  const filter: ApprovalListFilter = {
    status: (params.get("status") as WorkspaceApprovalStatus | "all") ?? undefined,
    projectId: params.get("projectId") ?? undefined,
    subjectType: (params.get("subjectType") as WorkspaceApprovalSubject) ?? undefined,
    subjectId: params.get("subjectId") ?? undefined,
    approverUserId: params.get("mine") === "true" ? owner.actorUserId : undefined,
  };
  try {
    return NextResponse.json({ approvals: await listApprovals(owner.businessId, filter) });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage);
  if (error) return error;
  const body = await readBody(request);
  try {
    return NextResponse.json({ approval: await requestApproval(owner, body) }, { status: 201 });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});
