import { NextRequest, NextResponse } from "next/server";
import { getSession, withTenantScope } from "@/lib/auth";
import { getProject } from "@/lib/ai-projects";
import { listMediaAssets } from "@/lib/media-service";

/**
 * Phase F capstone (with Phase G) — a project's files.
 *
 * GET — the Media Library assets that belong to this project (the images users
 *       sent the assistant inside the project, plus anything else tagged with
 *       this project_id). Read-only: files are created through the chat/media
 *       write paths and tagged with provenance there; this surface just shows a
 *       project its own files.
 *
 * Ownership is the authorization, the same shape as the project's notes/memory/
 * tasks routes: the project must belong to the caller's business, and the asset
 * list is scoped both by that business (RLS + the query's business_id) and by
 * this project's id.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id } = await context.params;

    const owner = { businessId: session.businessId, actorUserId: session.sub, projectId: id };
    const project = await getProject(owner);
    if (!project) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const { assets, total } = await listMediaAssets(session.businessId, {
      projectId: id,
      folderId: "any",
      limit: 100,
    });
    return NextResponse.json({ files: assets, total });
  },
);
