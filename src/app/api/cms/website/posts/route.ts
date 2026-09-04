import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { createCmsPost, type CmsPostInput } from "@/lib/cms/website-service";

/** `POST /api/cms/website/posts` — create a post on the connected CMS site. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: Partial<CmsPostInput>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await createCmsPost(session.businessId, {
    title: typeof body.title === "string" ? body.title : "",
    content: typeof body.content === "string" ? body.content : "",
    heroImage: typeof body.heroImage === "string" ? body.heroImage : undefined,
    categories: Array.isArray(body.categories) ? body.categories.filter((c) => typeof c === "string") : undefined,
  });

  if (!result.ok) {
    const status = result.error === "not_connected" ? 409 : result.error === "cms_unreachable" ? 503 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }

  return NextResponse.json({ post: result.data }, { status: 201 });
});
