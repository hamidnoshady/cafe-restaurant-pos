import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/auth";
import {
  EmailPasswordMismatchError,
  provisionBusiness,
  validateProvisionBody,
  type ProvisionRequestBody,
} from "@/lib/business-provisioning";
import { hasAnyUser } from "@/lib/setup-state";

/**
 * First-run bootstrap: on a completely empty database, creates the business,
 * its first location, and the Owner account in one step, then signs the Owner
 * in so the wizard can continue.
 *
 * Still refuses once any user exists. Phase 12 made a deployment capable of
 * holding many businesses, but adding one is a deliberate act — either a
 * super-admin provisioning it (Phase 15) or public signup, which is off unless
 * explicitly enabled (see /api/setup/signup). Leaving this route open would
 * have turned every install into an open registration endpoint by accident.
 */
export async function POST(request: NextRequest) {
  if (await hasAnyUser()) {
    return NextResponse.json({ error: "already_initialized" }, { status: 409 });
  }

  let body: ProvisionRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // The first-run wizard's mode choice. Anything other than the literal
  // 'local' is treated as connected, which is what every non-desktop caller
  // (public signup, the platform console) already sends by omission.
  const deploymentMode =
    (body as { deploymentMode?: unknown }).deploymentMode === "local" ? "local" : "connected";

  // Resolved before validation, not after: Phase 24 makes the Owner's mobile
  // required on a connected install (it is where their SMS second factor is
  // sent) and pointless on a local one, which enrols TOTP instead. Passing the
  // mode is what lets the validator tell those two cases apart.
  const validated = validateProvisionBody(body, { deploymentMode });
  if (!validated.input) return NextResponse.json({ error: validated.error }, { status: 400 });
  const input = validated.input;

  let created;
  try {
    created = await provisionBusiness({ ...input, deploymentMode });
  } catch (err) {
    if (err instanceof EmailPasswordMismatchError) {
      return NextResponse.json({ error: "email_password_mismatch" }, { status: 409 });
    }
    throw err;
  }

  const token = await signSession({
    sub: created.userId,
    role: "owner",
    businessId: created.businessId,
    businessSlug: created.businessSlug,
    businessSubdomain: created.businessSubdomain,
    locationId: null,
    fullName: input.ownerName,
    platformUserId: created.platformUserId,
  });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return res;
}
