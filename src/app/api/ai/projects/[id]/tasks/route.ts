import { NextRequest, NextResponse } from "next/server";
import { getSession, withTenantScope } from "@/lib/auth";
import { addTask, listTasks } from "@/lib/ai-projects";

/**
 * Phase F pt.3 — project tasks: units of work with a lifecycle (open -> done).
 *
 * GET  — list a project's tasks (open first, then completed)
 * POST — add an open task (source 'user'; the assistant adds tasks through the
 *        confirmed `project.task.add` action, which also lands here)
 *
 * Ownership is the authorization, the same shape as the notes/memory routes: a
 * task reaches tenant scope only through its parent project, and every query
 * here is scoped by the session's business.
 */

export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id } = await context.params;

    const tasks = await listTasks({
      businessId: session.businessId,
      actorUserId: session.sub,
      projectId: id,
    });
    return NextResponse.json({ tasks });
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
    // The write path is the same whether a person typed it or confirmed an
    // assistant proposal; the caller may tag the source, defaulting to 'user'.
    const source = body.source === "ai" ? "ai" : "user";

    try {
      const task = await addTask(
        { businessId: session.businessId, actorUserId: session.sub, projectId: id },
        { title: body.title, source },
      );
      return NextResponse.json({ task }, { status: 201 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal_error";
      if (message.includes("not found")) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      if (
        message.includes("character limit") ||
        message.includes("required") ||
        message.includes("too many")
      ) {
        return NextResponse.json({ error: message }, { status: 400 });
      }
      throw err;
    }
  },
);
