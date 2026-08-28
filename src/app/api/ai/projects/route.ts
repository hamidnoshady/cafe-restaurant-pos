import { NextRequest, NextResponse } from "next/server";
import { getSession, withTenantScope } from "@/lib/auth";
import { createProject, listProjects } from "@/lib/ai-projects";

/**
 * GET  — list the caller's projects (optionally including archived)
 * POST — create a new project
 */

export const GET = withTenantScope(async (request: NextRequest) => {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const includeArchived = url.searchParams.get("archived") === "true";
  const projects = await listProjects(
    { businessId: session.businessId, actorUserId: session.sub },
    { includeArchived },
  );
  return NextResponse.json({ projects });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body || typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  try {
    const project = await createProject(
      { businessId: session.businessId, actorUserId: session.sub },
      { name: body.name, instructions: body.instructions },
    );
    return NextResponse.json({ project }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "internal_error";
    if (message.includes("character limit")) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    throw err;
  }
});
