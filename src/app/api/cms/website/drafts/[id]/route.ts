import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { updateWebsitePost, websiteStatusFor } from "@/lib/website/content-service";

/** `PATCH /api/cms/website/drafts/[id]` — `website.post.update`: content only, never the publish state. */
export const PATCH = withTenantScope(async (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const { id } = await ctx.params;
  let body: { title?: unknown; body?: unknown; excerpt?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await updateWebsitePost(session.businessId, id, {
    ...(typeof body.title === "string" ? { title: body.title } : {}),
    ...(typeof body.body === "string" ? { body: body.body } : {}),
    ...(typeof body.excerpt === "string" ? { excerpt: body.excerpt } : {}),
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: websiteStatusFor(result.error) });
  return NextResponse.json({ post: result.data });
});
