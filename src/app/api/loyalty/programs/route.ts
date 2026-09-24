import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listPrograms, upsertProgram } from "@/lib/loyalty-service";

/** The business's loyalty programs (at most a handful), default first. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.loyaltyView);
  if (error) return error;
  return NextResponse.json({ programs: await listPrograms(session.businessId) });
});

/** Creates or edits one program by name. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.loyaltyManage);
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  try {
    const program = await upsertProgram(session.businessId, {
      name: body.name,
      earnPointsPer100000: body.earnPointsPer100000 as number | undefined,
      pointValueRial: body.pointValueRial as number | undefined,
      pointsExpiryDays: body.pointsExpiryDays as number | null | undefined,
      isActive: body.isActive as boolean | undefined,
      isDefault: body.isDefault as boolean | undefined,
    });
    return NextResponse.json({ ok: true, program });
  } catch (err) {
    return NextResponse.json({ error: "validation_failed", message: (err as Error).message }, { status: 400 });
  }
});
