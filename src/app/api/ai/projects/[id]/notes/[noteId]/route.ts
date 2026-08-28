import { NextRequest, NextResponse } from "next/server";
import { getSession, withTenantScope } from "@/lib/auth";
import { deleteNote } from "@/lib/ai-projects";

/** DELETE — remove a note from a project */

export const DELETE = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string; noteId: string }> }) => {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id, noteId } = await context.params;

    const deleted = await deleteNote({
      businessId: session.businessId,
      actorUserId: session.sub,
      projectId: id,
      noteId,
    });
    if (!deleted) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  },
);
