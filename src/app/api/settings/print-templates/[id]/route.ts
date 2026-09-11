import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { deletePrintTemplate, updatePrintTemplate } from "@/lib/print-templates-service";
import { resolveActiveLocation } from "@/lib/setup-state";

export const PUT = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const { id } = await context.params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await updatePrintTemplate({
    locationId: location.id,
    id,
    template: body.template,
    isDefault: typeof body.isDefault === "boolean" ? body.isDefault : undefined,
  });
  if (result.error) {
    const status = result.error === "template_not_found" ? 404 : result.error === "duplicate_template_name" ? 409 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ template: result.template });
});

export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const { id } = await context.params;
  const removed = await deletePrintTemplate(location.id, id);
  if (!removed) return NextResponse.json({ error: "template_not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
});
