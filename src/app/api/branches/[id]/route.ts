import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  BranchError,
  deactivateBranch,
  reactivateBranch,
  updateBranch,
} from "@/lib/branch-service";

function errorResponse(err: unknown): NextResponse {
  if (err instanceof BranchError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

/**
 * Renames a branch, edits its address/phone/timezone, or activates and
 * deactivates it.
 *
 * The two kinds of change are deliberately **not** accepted in the same
 * request. They are separate operations with separate rules — deactivation can
 * fail on open orders long after a rename has already been committed — and the
 * previous handler ran them in sequence with no transaction around the pair,
 * so a body carrying both could rename the branch, fail to deactivate it, and
 * return a single error that made the (already saved) rename look rejected.
 * Refusing the combination outright is honest; the screen sends one at a time.
 */
export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.locationsManage);
  if (error) return error;

  const { id } = await context.params;
  let body: {
    name?: string;
    address?: string | null;
    phone?: string | null;
    timezone?: string;
    color?: string;
    isActive?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const editsFields =
    body.name !== undefined ||
    body.address !== undefined ||
    body.phone !== undefined ||
    body.timezone !== undefined ||
    body.color !== undefined;
  const togglesActive = body.isActive !== undefined;

  if (togglesActive && typeof body.isActive !== "boolean") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (togglesActive && editsFields) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  // An empty body used to answer `{ ok: true }` having done nothing at all.
  if (!togglesActive && !editsFields) {
    return NextResponse.json({ error: "nothing_to_change" }, { status: 400 });
  }

  try {
    if (togglesActive) {
      if (body.isActive) await reactivateBranch(session.businessId, id, session.sub);
      else await deactivateBranch(session.businessId, id, session.sub);
    } else {
      await updateBranch({
        businessId: session.businessId,
        locationId: id,
        actorId: session.sub,
        name: body.name,
        address: body.address,
        phone: body.phone,
        timezone: body.timezone,
        color: body.color,
      });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
});
