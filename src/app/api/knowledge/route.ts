import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { knowledgeSection } from "@/lib/knowledge-base";

/**
 * The member-facing side of the knowledge base (migration 0117). A page's
 * «آموزش» icon asks here for its section's learning page; the response is the
 * URL of the active entry, or `entry: null` when the super-admin has not
 * published one yet (the modal then says so instead of failing).
 *
 * `knowledge_base_entries` is a platform catalogue — no business_id, the same
 * shape as `feature_flags` — so the read needs no tenant scope of its own;
 * `withTenantScope` only establishes the request's boundary the way every
 * other member route does. Any signed-in member may read: learning the
 * screen you are on is not a privilege, and the catalogue carries no
 * business data.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { error } = await requireMember();
  if (error) return error;

  const section = (request.nextUrl.searchParams.get("section") ?? "").trim();
  const known = knowledgeSection(section);
  if (!known) {
    return NextResponse.json({ error: "unknown_section" }, { status: 400 });
  }

  const { rows } = await query<{ section: string; url: string; is_active: boolean }>(
    "SELECT section, url, is_active FROM knowledge_base_entries WHERE section = $1 AND is_active = true",
    [known.key],
  );
  const entry = rows[0];

  return NextResponse.json({
    entry: entry ? { section: entry.section, label: known.label, url: entry.url } : null,
  });
});
