import { NextRequest, NextResponse } from "next/server";
import { getSession, withTenantScope } from "@/lib/auth";
import { deleteTask, setTaskStatus } from "@/lib/ai-projects";

/**
 * PATCH  — flip a task open<->done ({ done: boolean }); drops it from / returns
 *          it to the project's prompt context accordingly.
 * DELETE — remove a task from a project.
 *
 * Ownership through the parent project is the authorization, the same shape as
 * the notes/memory routes.
 */

export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string; taskId: string }> }) => {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id, taskId } = await context.params;

    const body = await request.json().catch(() => null);
    if (!body || typeof body.done !== "boolean") {
      return NextResponse.json({ error: "done is required" }, { status: 400 });
    }

    const task = await setTaskStatus(
      { businessId: session.businessId, actorUserId: session.sub, projectId: id, taskId },
      body.done,
    );
    if (!task) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ task });
  },
);

export const DELETE = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string; taskId: string }> }) => {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id, taskId } = await context.params;

    const deleted = await deleteTask({
      businessId: session.businessId,
      actorUserId: session.sub,
      projectId: id,
      taskId,
    });
    if (!deleted) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  },
);
