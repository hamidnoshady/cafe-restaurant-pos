import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { setRollupLocationActive } from "@/lib/rollup-service";

/** Deactivate (or reactivate) a registered location — deactivation also revokes its token at ingest. */
export const PATCH = withTenantScope(async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner");
  if (error) return error;

  let body: { isActive?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body.isActive !== "boolean") {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const { id } = await params;
  const updated = await setRollupLocationActive(session.businessId, id, body.isActive);
  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
});
