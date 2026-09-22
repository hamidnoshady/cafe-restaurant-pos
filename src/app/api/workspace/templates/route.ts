import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { archiveTemplate, listTemplates, saveTemplate } from "@/lib/workspace";
import { PERMISSIONS, handleWorkspaceError, readBody, workspaceOwner } from "../guard";

/**
 * Project blueprints. The GET returns the built-in catalogue (code, so every
 * tenant has it without seeding) merged with the business's own rows, a
 * business key overriding a built-in of the same name.
 *
 * Reconfiguring templates is structural — it reshapes every project created
 * afterwards — so the write sits on `workspace.manage`.
 */
export const GET = withTenantScope(async () => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView);
  if (error) return error;
  try {
    return NextResponse.json({ templates: await listTemplates(owner.businessId) });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage);
  if (error) return error;
  const body = await readBody(request);
  try {
    return NextResponse.json({ templates: await saveTemplate(owner, body) }, { status: 201 });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});

export const DELETE = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage);
  if (error) return error;
  const key = new URL(request.url).searchParams.get("key") ?? "";
  try {
    // Archives the business's own row. A built-in cannot be archived — it is
    // code, shared by every tenant, and hiding it for one would mean a
    // per-tenant exclusion table for no gain.
    return NextResponse.json({ templates: await archiveTemplate(owner.businessId, key) });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});
