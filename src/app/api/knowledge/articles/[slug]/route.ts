import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { getKbArticleBySlug } from "@/lib/knowledge-service";

interface Ctx {
  params: Promise<{ slug: string }>;
}

/**
 * One published knowledge-base article (migration 0131) with its tags and
 * related reads — the body «مرکز آموزش» renders with anchored headings,
 * video, images and code blocks.
 */
export const GET = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { error } = await requireMember();
  if (error) return error;

  const { slug } = await ctx.params;
  const article = await getKbArticleBySlug(decodeURIComponent(slug));
  if (!article) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ article });
});
