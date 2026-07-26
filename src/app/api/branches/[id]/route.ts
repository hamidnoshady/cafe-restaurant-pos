import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { BranchError, deactivateBranch, reactivateBranch, updateBranch } from "@/lib/branch-service";

function errorResponse(err: unknown): NextResponse {
  if (err instanceof BranchError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

/** Renames a branch or edits its address/phone. */
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requirePermission(PERMISSIONS.locationsManage);
  if (error) return error;

  const { id } = await context.params;
  let body: { name?: string; address?: string | null; phone?: string | null; isActive?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    if (body.isActive !== undefined) {
      if (body.isActive) await reactivateBranch(session.businessId, id, session.sub);
      else await deactivateBranch(session.businessId, id, session.sub);
    }
    if (body.name !== undefined || body.address !== undefined || body.phone !== undefined) {
      await updateBranch({
        businessId: session.businessId,
        locationId: id,
        actorId: session.sub,
        name: body.name,
        address: body.address,
        phone: body.phone,
      });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
