import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { updateCmsOrderStatus } from "@/lib/cms/website-service";

/**
 * `PATCH /api/cms/website/orders/[id]` — move an order's status on the CMS
 * (paid / cancelled / refunded), the one e-commerce write the owner/manager
 * works in. The CMS's own hooks settle stock and snapshot the change.
 */
export const PATCH = withTenantScope(async (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsContentManage);
  if (error) return error;

  const { id } = await ctx.params;

  let body: { status?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await updateCmsOrderStatus(session.businessId, id, typeof body.status === "string" ? body.status : "");
  if (!result.ok) {
    const status = result.error === "not_found" ? 404 : result.error === "forbidden" ? 403 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }

  return NextResponse.json({ order: result.data });
});
