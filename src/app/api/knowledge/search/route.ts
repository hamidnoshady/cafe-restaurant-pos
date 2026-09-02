import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { searchKbArticles } from "@/lib/knowledge-service";

/**
 * Knowledge-centre search (migration 0131): ranked full-text search over
 * published articles (title/slug/summary weighted up). `q` in the query
 * string; an empty query is not an error — it is "no results yet", which the
 * UI shows as the untouched search box.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { error } = await requireMember();
  if (error) return error;

  const q = request.nextUrl.searchParams.get("q") ?? "";
  const results = await searchKbArticles(q);
  return NextResponse.json({ q, results });
});
