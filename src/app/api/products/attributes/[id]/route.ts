import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { requireProductWorkspaceForApi } from "@/lib/industry-guard";
import {
  deleteAttributeDefinition,
  updateAttributeDefinition,
} from "@/lib/product-attributes-service";

/** Edits one attribute's title, option values or status. */
export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;

  const { id } = await context.params;
  let body: { name?: string; options?: string[]; isActive?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { definition, error: updateError } = await updateAttributeDefinition(id, body);
  if (updateError) {
    const status = updateError === "not_found" ? 404 : updateError === "duplicate_name" ? 409 : 400;
    return NextResponse.json({ error: updateError }, { status });
  }
  return NextResponse.json({ ok: true, definition });
});

/** Deletes an attribute. Existing variant rows keep their stored copy. */
export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;

  const { id } = await context.params;
  const deleted = await deleteAttributeDefinition(id);
  if (!deleted) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
});
