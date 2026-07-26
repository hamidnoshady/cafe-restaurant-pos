import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { setCourierActive } from "@/lib/delivery-service";
import { resolveActiveLocation } from "@/lib/setup-state";

interface PatchBody {
  isActive?: boolean;
}

/** Activate / deactivate a courier. Deactivating keeps history intact but drops them from the assign list. */
export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: PatchBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body.isActive !== "boolean") return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const result = await setCourierActive(location.id, id, body.isActive);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, courier: result.data });
});
