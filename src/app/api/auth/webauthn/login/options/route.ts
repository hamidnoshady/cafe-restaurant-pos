import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/db";
import { beginWebauthnAuthentication, resolveLoginBusinessId } from "@/lib/employee-service";

/**
 * Phase 20 Wave 3 — step 1 of a biometric login. Public, like `pin-login`
 * itself: there is no session yet by definition. `employeeId` is already
 * known — the login picker (Wave 2) always resolves a name before offering
 * either PIN or biometric, so this never scans "every eligible employee"
 * the way an unscoped, discoverable-credential ("usernameless") WebAuthn
 * flow would need to.
 */
export async function POST(request: NextRequest) {
  let body: { employeeId?: string; businessId?: string; businessSlug?: string; locationId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.employeeId) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { businessId, error } = await resolveLoginBusinessId(body);
  if (!businessId) {
    return NextResponse.json({ error: error ?? "unknown_business" }, { status: 400 });
  }

  return withTenant(businessId, async () => {
    const ceremony = await beginWebauthnAuthentication(body.employeeId!, businessId);
    if (!ceremony) {
      return NextResponse.json({ error: "no_webauthn_credentials" }, { status: 404 });
    }
    return NextResponse.json(ceremony);
  });
}
