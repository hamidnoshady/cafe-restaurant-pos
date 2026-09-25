import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { draftWebsitePost, listWebsitePostsTool, websiteStatusFor } from "@/lib/website/content-service";
import { markdownToLexical } from "@/lib/website/providers/payload-content";

/** Adapter-backed post list for the CMS content screen — no credential reaches it. */
export const GET = withTenantScope(async (_request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsView);
  if (error) return error;
  const result = await listWebsitePostsTool(session.businessId, { limit: 20 });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: websiteStatusFor(result.error) });
  // Keep this content-screen response compatible with the older CmsPost UI
  // while making the read itself go through the timeout/breaker adapter path.
  return NextResponse.json({
    hasMore: result.data.hasMore,
    posts: result.data.posts.map((post) => ({
      id: post.id, title: post.title, slug: post.slug, content: markdownToLexical(post.body),
      heroImage: post.featuredImageUrl ? { id: "", url: post.featuredImageUrl } : null,
      publishedAt: post.publishedAt, updatedAt: post.updatedAt, createdAt: post.createdAt,
      _status: post.status, excerpt: post.excerpt,
    })),
  });
});

/**
 * Phase 38 (issue #382) — `POST /api/cms/website/drafts`: the assistant's
 * `website.post.draft`, confirmed by a human and sent from the browser. Body
 * is Markdown; the adapter turns it into whatever the site stores. It is
 * always a draft — nothing here can publish.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsContentManage);
  if (error) return error;

  let body: { title?: unknown; body?: unknown; slug?: unknown; excerpt?: unknown; featuredImageId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await draftWebsitePost(session.businessId, {
    title: typeof body.title === "string" ? body.title : "",
    body: typeof body.body === "string" ? body.body : "",
    slug: typeof body.slug === "string" ? body.slug : undefined,
    excerpt: typeof body.excerpt === "string" ? body.excerpt : undefined,
    featuredImageId: typeof body.featuredImageId === "string" ? body.featuredImageId : undefined,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: websiteStatusFor(result.error) });
  return NextResponse.json({ post: result.data }, { status: 201 });
});
