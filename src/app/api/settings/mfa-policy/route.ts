import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { getMfaPolicy, setMfaPolicy } from "@/lib/mfa-policy";

/**
 * Phase 24 Wave 2 — the per-business two-factor policy.
 *
 * Exactly one knob, per the spec: "A business may opt to extend the requirement
 * to `manager`; off by default." `owner` is not negotiable and is deliberately
 * not exposed here — the requirement on the full permission set is the point of
 * the wave, not a preference.
 *
 * Guarded on the `owner` role rather than the `settings.manage` permission that
 * gates the rest of this directory. A manager holding `settings.manage` — the
 * default on most businesses — could otherwise switch off the requirement that
 * applies to managers, which is to say vote on whether they themselves need a
 * second factor.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner");
  if (error) return error;

  return NextResponse.json({ policy: await getMfaPolicy(session.businessId) });
});

export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner");
  if (error) return error;

  let body: { requireForManagers?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const requireForManagers = body.requireForManagers === true;
  const policy = await setMfaPolicy(session.businessId, { requireForManagers });

  // Turning this on can lock a manager out at their next login once their own
  // grace window expires, and turning it off weakens the business's posture.
  // Either direction is worth a row in the trail.
  await query(
    `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, 'settings.mfa_policy.update', 'settings', 'mfa.policy', $4)`,
    [session.businessId, session.locationId, session.sub, JSON.stringify({ requireForManagers })],
  );

  return NextResponse.json({ policy });
});
