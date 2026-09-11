import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { createPrintTemplate, listPrintTemplates } from "@/lib/print-templates-service";
import { resolveActiveLocation } from "@/lib/setup-state";

/** The branch's own designed templates. The five built-ins are code, not rows. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ templates: [] });
  return NextResponse.json({ templates: await listPrintTemplates(location.id) });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await createPrintTemplate({
    locationId: location.id,
    template: body.template,
    isDefault: body.isDefault === true,
  });
  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: result.error === "duplicate_template_name" ? 409 : 400 });
  }
  return NextResponse.json({ template: result.template }, { status: 201 });
});
