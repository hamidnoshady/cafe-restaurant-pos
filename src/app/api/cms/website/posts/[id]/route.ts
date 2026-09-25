import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { deleteCmsPost, updateCmsPost, type CmsPostInput } from "@/lib/cms/website-service";

function statusFor(error: string): number {
  if (error === "not_found") return 404;
  if (error === "forbidden") return 403;
  if (error === "not_connected") return 409;
  if (error === "cms_unreachable") return 503;
  return 400;
}

/** `PATCH /api/cms/website/posts/[id]` — edit a post on the connected CMS site. */
export const PATCH = withTenantScope(async (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsContentManage);
  if (error) return error;

  const { id } = await ctx.params;

  let body: Partial<CmsPostInput>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await updateCmsPost(session.businessId, id, {
    ...(typeof body.title === "string" ? { title: body.title } : {}),
    ...(typeof body.content === "string" ? { content: body.content } : {}),
    ...(typeof body.heroImage === "string" ? { heroImage: body.heroImage } : {}),
    ...(Array.isArray(body.categories) ? { categories: body.categories.filter((c) => typeof c === "string") } : {}),
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: statusFor(result.error) });
  return NextResponse.json({ post: result.data });
});

/** `DELETE /api/cms/website/posts/[id]` — remove a post from the connected CMS site. */
export const DELETE = withTenantScope(async (_request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsContentManage);
  if (error) return error;

  const { id } = await ctx.params;
  const result = await deleteCmsPost(session.businessId, id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: statusFor(result.error) });
  return NextResponse.json({ deleted: true });
});
