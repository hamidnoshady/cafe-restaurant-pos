import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/db";
import { resolveDeviceId } from "@/lib/device-service";
import { loginRoster, resolveLoginBusinessId } from "@/lib/employee-service";

/**
 * Phase 20 Wave 2 — the name-then-PIN login redesign's first step: who is
 * signing in. Deliberately public (there is no session yet, by definition),
 * and deliberately thin: only name, role, and photo, the same fields a
 * badge on a POS terminal would show, never a PIN or anything from
 * `employees` beyond its photo.
 *
 * Wave 4 — an optional `deviceToken` (this terminal's paired-device token,
 * if any, carried client-side — see src/app/login/page.tsx) narrows
 * `hasWebauthn` to credentials actually registered on this terminal; an
 * unresolvable or absent token behaves exactly as before pairing existed.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const { businessId, error } = await resolveLoginBusinessId({
    businessId: params.get("businessId") ?? undefined,
    businessSlug: params.get("businessSlug") ?? undefined,
    locationId: params.get("locationId") ?? undefined,
    host: request.headers.get("host"),
  });
  if (!businessId) {
    return NextResponse.json({ error: error ?? "unknown_business" }, { status: 400 });
  }

  return withTenant(businessId, async () => {
    const deviceId = await resolveDeviceId(params.get("deviceToken"), businessId);
    const employees = await loginRoster(businessId, params.get("locationId"), deviceId);
    return NextResponse.json({ employees });
  });
}
