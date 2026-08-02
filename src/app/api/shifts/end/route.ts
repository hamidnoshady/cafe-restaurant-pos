import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { isValidCashFloat } from "@/lib/shift";
import { ShiftError, closeOwnShift } from "@/lib/shift-service";

/** Self-service clock-out (Phase 20 Wave 5) — ends the caller's own open shift. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("cashier", "waiter", "kitchen");
  if (error) return error;

  let body: { closingFloat?: number };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  if (body.closingFloat !== undefined && !isValidCashFloat(body.closingFloat)) {
    return NextResponse.json({ error: "invalid_amount" }, { status: 400 });
  }

  try {
    const result = await closeOwnShift(session.sub, session.businessId, body.closingFloat ?? null);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ShiftError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
