import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  CUSTOM_FIELD_TARGETS,
  archiveCustomField,
  listCustomFields,
  saveCustomField,
  type CustomFieldTarget,
  type CustomFieldType,
} from "@/lib/crm-custom-fields-service";
import { isUuid } from "@/lib/uuid";

/**
 * Custom field definitions — «فیلدهای سفارشی».
 *
 * Defining a field is configuration, not data entry, so writes need
 * `crm.configure`. Reading the definitions only needs `crm.view`: every screen
 * that renders a customer file has to know which fields exist, and gating that
 * behind an admin permission would blank the extra fields for ordinary staff.
 */
function parseTarget(value: string | null): CustomFieldTarget | null {
  return (CUSTOM_FIELD_TARGETS as readonly string[]).includes(value ?? "")
    ? (value as CustomFieldTarget)
    : null;
}

export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmView);
  if (error) return error;

  const target = parseTarget(request.nextUrl.searchParams.get("target"));
  if (!target) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  return NextResponse.json({ fields: await listCustomFields(session.businessId, target) });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmConfigure);
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const target = parseTarget(typeof body.target === "string" ? body.target : null);
  if (!target) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const result = await saveCustomField(
    session.businessId,
    {
      id: typeof body.id === "string" && isUuid(body.id) ? body.id : undefined,
      target,
      label: String(body.label ?? ""),
      fieldType: String(body.fieldType ?? "") as CustomFieldType,
      options: Array.isArray(body.options) ? body.options.map(String) : undefined,
      isRequired: body.isRequired === true,
      helpText: typeof body.helpText === "string" ? body.helpText : undefined,
      displayOrder:
        typeof body.displayOrder === "number" ? body.displayOrder : undefined,
    },
    { name: session.fullName, userId: session.sub },
  );

  if (!result.ok) {
    const status = result.error === "not_found" ? 404 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ field: result.field });
});

export const DELETE = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmConfigure);
  if (error) return error;

  const id = request.nextUrl.searchParams.get("id") ?? "";
  if (!isUuid(id)) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  // Archive, never delete. Answers already recorded against the field stay
  // readable — see the service.
  const archived = await archiveCustomField(session.businessId, id, {
    name: session.fullName,
    userId: session.sub,
  });
  if (!archived) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
});
