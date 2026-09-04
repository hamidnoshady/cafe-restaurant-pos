import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { draftWebsitePost, websiteStatusFor } from "@/lib/website/content-service";

/**
 * Phase 38 (issue #382) — `POST /api/cms/website/drafts`: the assistant's
 * `website.post.draft`, confirmed by a human and sent from the browser. Body
 * is Markdown; the adapter turns it into whatever the site stores. It is
 * always a draft — nothing here can publish.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: { title?: unknown; body?: unknown; excerpt?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await draftWebsitePost(session.businessId, {
    title: typeof body.title === "string" ? body.title : "",
    body: typeof body.body === "string" ? body.body : "",
    excerpt: typeof body.excerpt === "string" ? body.excerpt : undefined,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: websiteStatusFor(result.error) });
  return NextResponse.json({ post: result.data }, { status: 201 });
});
