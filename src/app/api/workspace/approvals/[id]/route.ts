import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { decideApproval } from "@/lib/workspace";
import { PERMISSIONS, handleWorkspaceError, readBody, workspaceOwner } from "../../guard";

/**
 * POST — decide a pending approval. Gated on `workspace.approve`, which no
 * role below manager holds by preset.
 *
 * The decision propagates to the subject inside the service: approving a
 * contract activates it, rejecting a document marks it rejected. An approval
 * that changed nothing would be a comment.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceApprove);
    if (error) return error;
    const { id } = await context.params;
    const body = await readBody(request);
    const decision = String(body.decision ?? "");
    if (decision !== "approved" && decision !== "rejected" && decision !== "cancelled") {
      return NextResponse.json({ error: "invalid_decision" }, { status: 400 });
    }
    try {
      const approval = await decideApproval(owner, id, decision, String(body.note ?? ""));
      // Null means "no pending approval with this id" — either it never
      // existed for this business, or somebody else already decided it.
      if (!approval) return NextResponse.json({ error: "approval_not_pending" }, { status: 409 });
      return NextResponse.json({ approval });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);
