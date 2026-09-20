import { NextRequest, NextResponse } from "next/server";
import { getSession, withTenantScope } from "@/lib/auth";
import { deleteMemory } from "@/lib/ai-projects";

/** DELETE — forget a memory entry (removes it from the project's prompt context). */

export const DELETE = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string; memoryId: string }> }) => {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id, memoryId } = await context.params;

    const deleted = await deleteMemory({
      businessId: session.businessId,
      actorUserId: session.sub,
      projectId: id,
      memoryId,
    });
    if (!deleted) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  },
);
