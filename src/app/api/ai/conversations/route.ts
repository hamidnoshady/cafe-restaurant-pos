import { NextRequest, NextResponse } from "next/server";
import { getSession, withTenantScope } from "@/lib/auth";
import { listConversations } from "@/lib/ai-conversations";

const DEFAULT_LIMIT = 30;

function parseBefore(raw: string | null): string | null {
  if (!raw) return null;
  return Number.isNaN(Date.parse(raw)) ? null : raw;
}

/**
 * A member's own AI conversations, most recently active first. Ownership
 * (not role) is the access control here — see ai-conversations.ts.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const limitParam = Number(url.searchParams.get("limit"));
  const conversations = await listConversations(
    { businessId: session.businessId, actorUserId: session.sub },
    {
      limit: Number.isFinite(limitParam) && limitParam > 0 ? limitParam : DEFAULT_LIMIT,
      before: parseBefore(url.searchParams.get("before")),
    },
  );
  return NextResponse.json({ conversations });
});
