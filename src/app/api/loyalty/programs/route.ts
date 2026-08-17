import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { listPrograms, upsertProgram } from "@/lib/loyalty-service";

/** The business's loyalty programs (at most a handful), default first. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager", "cashier");
  if (error) return error;
  return NextResponse.json({ programs: await listPrograms(session.businessId) });
});

/** Creates or edits one program by name. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: {
    name?: string;
    earnPointsPer100000?: number;
    pointValueRial?: number;
    pointsExpiryDays?: number | null;
    isActive?: boolean;
    isDefault?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!body.name?.trim()) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  try {
    const program = await upsertProgram(session.businessId, {
      name: body.name,
      earnPointsPer100000: body.earnPointsPer100000,
      pointValueRial: body.pointValueRial,
      pointsExpiryDays: body.pointsExpiryDays,
      isActive: body.isActive,
      isDefault: body.isDefault,
    });
    return NextResponse.json({ ok: true, program });
  } catch (err) {
    return NextResponse.json({ error: "validation_failed", message: (err as Error).message }, { status: 400 });
  }
});
