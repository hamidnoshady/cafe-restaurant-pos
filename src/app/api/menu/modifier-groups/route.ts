import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { validateModifierGroupCreate } from "@/lib/menu-validation";
import { createModifierGroup } from "@/lib/menu-service";
import { resolveActiveLocation } from "@/lib/setup-state";

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.menuEdit);
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const input = validateModifierGroupCreate(body);
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const result = await createModifierGroup(location.id, input.value);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, id: result.id });
});
