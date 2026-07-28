import { NextRequest, NextResponse } from "next/server";
import { requirePlatformCapability, platformAudit, withPlatformScope } from "@/lib/platform-auth";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/auth";
import {
  startImpersonation,
  getBusiness,
  BusinessNotImpersonableError,
  type ImpersonationMode,
} from "@/lib/platform-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Enter a business as its owner — support access / impersonation.
 *
 * The order of operations is the whole security story, and it is enforced here
 * and in the service layer together:
 *
 *   1. `startImpersonation` writes the grant row FIRST, inside a transaction,
 *      so a tenant session can never be minted without a durable record naming
 *      the admin, the business, the mode and the window (exit criterion 3).
 *   2. Only then do we mint a tenant `pos_session` — carrying the `imp` claim
 *      that marks it as an operator's borrowed seat, not a real login. The
 *      cookie is the normal tenant cookie so the whole app "just works", but
 *      the claim lets the middleware enforce read-only and lets every write be
 *      attributed to the admin.
 *   3. We audit the entry.
 *
 * `read_only` needs `impersonate.readOnly` (support and up); `full` needs
 * `impersonate.full` (owner only) — full access can change a customer's data,
 * so it is the most trusted capability short of hard-delete.
 */
export const POST = withPlatformScope(async (request: NextRequest, ctx: Ctx) => {
  const { id } = await ctx.params;

  let body: { mode?: ImpersonationMode; reason?: string; minutes?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const mode: ImpersonationMode = body.mode === "full" ? "full" : "read_only";
  const capability = mode === "full" ? "impersonate.full" : "impersonate.readOnly";
  const { session, error } = await requirePlatformCapability(capability);
  if (error) return error;

  try {
    const { grant, userId, fullName } = await startImpersonation({
      adminId: session.padmin,
      businessId: id,
      mode,
      reason: body.reason,
      minutes: body.minutes,
    });

    // Mint the tenant session for the owner membership, tagged as impersonation.
    // locationId null: an owner roams every branch, and so does the operator
    // standing in for them. The business was just confirmed to exist by
    // startImpersonation, so this second read is only for its slug.
    const business = await getBusiness(id);
    const token = await signSession({
      sub: userId,
      role: "owner",
      businessId: id,
      businessSlug: business?.slug,
      locationId: null,
      fullName,
      imp: { grantId: grant.id, adminId: session.padmin, mode },
    });

    await platformAudit({
      adminId: session.padmin,
      businessId: id,
      action: "impersonation.start",
      entity: "impersonation_grant",
      entityId: grant.id,
      payload: { mode, minutes: minutesBetween(grant.createdAt, grant.expiresAt), reason: grant.reason },
    });

    const res = NextResponse.json({
      grant: { id: grant.id, mode: grant.mode, expiresAt: grant.expiresAt },
    });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    return res;
  } catch (err) {
    if (err instanceof BusinessNotImpersonableError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
});

/** Whole minutes between two ISO timestamps, for the audit payload. */
function minutesBetween(from: string, to: string): number {
  return Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60000);
}
