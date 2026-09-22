import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  addChecklistItem,
  deleteChecklistItem,
  getWorkspaceTask,
  listChecklist,
  requireProjectCapability,
  setChecklistItem,
} from "@/lib/workspace";
import { PERMISSIONS, handleWorkspaceError, readBody, workspaceOwner } from "../../../guard";

/**
 * A task's sub-steps. Ticking one is `contribute` work — the whole point of
 * the contributor role is that somebody doing the job can record progress on
 * it without being able to re-scope the task.
 */
async function taskProject(businessId: string, taskId: string): Promise<string | null> {
  const task = await getWorkspaceTask(businessId, taskId);
  return task?.projectId ?? null;
}

export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      const projectId = await taskProject(owner.businessId, id);
      if (!projectId) return NextResponse.json({ error: "task_not_found" }, { status: 404 });
      await requireProjectCapability(owner, projectId, "view", true);
      return NextResponse.json({ checklist: await listChecklist(id) });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);

export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    const body = await readBody(request);
    try {
      const projectId = await taskProject(owner.businessId, id);
      if (!projectId) return NextResponse.json({ error: "task_not_found" }, { status: 404 });
      await requireProjectCapability(owner, projectId, "contribute", true);
      return NextResponse.json({ checklist: await addChecklistItem(id, String(body.title ?? "")) }, { status: 201 });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);

export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    const body = await readBody(request);
    try {
      const projectId = await taskProject(owner.businessId, id);
      if (!projectId) return NextResponse.json({ error: "task_not_found" }, { status: 404 });
      await requireProjectCapability(owner, projectId, "contribute", true);
      const checklist = await setChecklistItem(id, String(body.itemId ?? ""), body.done === true);
      return NextResponse.json({ checklist });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);

export const DELETE = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    const itemId = new URL(request.url).searchParams.get("itemId") ?? "";
    try {
      const projectId = await taskProject(owner.businessId, id);
      if (!projectId) return NextResponse.json({ error: "task_not_found" }, { status: 404 });
      await requireProjectCapability(owner, projectId, "edit", true);
      return NextResponse.json({ checklist: await deleteChecklistItem(id, itemId) });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);
