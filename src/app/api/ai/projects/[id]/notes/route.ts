import { NextRequest, NextResponse } from "next/server";
import { getSession, withTenantScope } from "@/lib/auth";
import { addNote, listNotes } from "@/lib/ai-projects";

/**
 * GET  — list notes for a project
 * POST — add a note to a project
 */

export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id } = await context.params;

    const notes = await listNotes({
      businessId: session.businessId,
      actorUserId: session.sub,
      projectId: id,
    });
    return NextResponse.json({ notes });
  },
);

export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id } = await context.params;

    const body = await request.json().catch(() => null);
    if (!body || typeof body.title !== "string") {
      return NextResponse.json({ error: "title is required" }, { status: 400 });
    }

    try {
      const note = await addNote(
        { businessId: session.businessId, actorUserId: session.sub, projectId: id },
        { title: body.title, content: body.content ?? "" },
      );
      return NextResponse.json({ note }, { status: 201 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal_error";
      if (message.includes("not found")) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      if (message.includes("character limit")) {
        return NextResponse.json({ error: message }, { status: 400 });
      }
      throw err;
    }
  },
);
