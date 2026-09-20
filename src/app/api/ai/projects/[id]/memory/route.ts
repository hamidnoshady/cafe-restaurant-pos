import { NextRequest, NextResponse } from "next/server";
import { getSession, withTenantScope } from "@/lib/auth";
import { addMemory, listMemory } from "@/lib/ai-projects";

/**
 * Phase F — project memory: standing facts the assistant carries for a project.
 *
 * GET  — list a project's memory entries
 * POST — add one (source 'user'; the assistant writes memory through the
 *        confirmed `project.memory.add` action, which also lands here)
 *
 * Ownership is the authorization, the same shape as the notes routes: memory
 * reaches tenant scope only through its parent project, and every query here is
 * scoped by the session's business.
 */

export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id } = await context.params;

    const memory = await listMemory({
      businessId: session.businessId,
      actorUserId: session.sub,
      projectId: id,
    });
    return NextResponse.json({ memory });
  },
);

export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id } = await context.params;

    const body = await request.json().catch(() => null);
    if (!body || typeof body.content !== "string") {
      return NextResponse.json({ error: "content is required" }, { status: 400 });
    }
    // The write path is the same whether a person typed it or confirmed an
    // assistant proposal; the caller may tag the source, defaulting to 'user'.
    const source = body.source === "ai" ? "ai" : "user";

    try {
      const memory = await addMemory(
        { businessId: session.businessId, actorUserId: session.sub, projectId: id },
        { content: body.content, source },
      );
      return NextResponse.json({ memory }, { status: 201 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal_error";
      if (message.includes("not found")) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      if (message.includes("character limit") || message.includes("required") || message.includes("full")) {
        return NextResponse.json({ error: message }, { status: 400 });
      }
      throw err;
    }
  },
);
