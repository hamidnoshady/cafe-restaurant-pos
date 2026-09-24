import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { publishWebsitePost, websiteStatusFor } from "@/lib/website/content-service";

/**
 * `POST /api/cms/website/drafts/[id]/publish` — `website.post.publish`.
 *
 * The one website action with no executor: it is only ever reached from a
 * signed-in person's confirm click. A background tick, a coworker job and an
 * MCP client have no way to call this — `ACTION_CATALOG` marks the action
 * `alwaysConfirm` and the tests pin that.
 */
export const POST = withTenantScope(async (_request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.websitePublish);
  if (error) return error;

  const { id } = await ctx.params;
  const result = await publishWebsitePost(session.businessId, id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: websiteStatusFor(result.error) });
  return NextResponse.json({ post: result.data });
});
