import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { getSession, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { toLatinDigits } from "@/lib/digits";
import { auditLoginFailure, checkLoginLockout } from "@/lib/employee-service";

/**
 * Phase 20 Wave 2 — confirms the caller's own PIN to dismiss the client-side
 * lock screen. Deliberately narrow: it re-checks the *already-authenticated*
 * caller's own `pin_hash` and nothing else — no new session is minted (the
 * existing one never stopped being valid; the screen was just visually
 * locked) and no other employee's PIN is ever accepted, so this is not a
 * second login path and needs no role list of its own.
 *
 * A 4-digit PIN is only 10,000 combinations, and unlike pin-login this route
 * carried no lockout of its own — an attacker at an unattended, already
 * signed-in device could otherwise script the unlock screen at the shared
 * per-business API budget (300/min) with nothing to stop them. It shares
 * `employee-service.ts`'s existing lockout (5 failures / 15 minutes), keyed
 * on the same `users.id` pin-login already locks.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const lockout = await checkLoginLockout(session.businessId, session.sub);
  if (lockout.locked) {
    return NextResponse.json(
      { error: "account_locked", lockedUntil: lockout.lockedUntil },
      { status: 423 },
    );
  }

  let body: { pin?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const pin = body.pin ? toLatinDigits(String(body.pin)) : "";
  if (!/^\d{4}$/.test(pin)) {
    return NextResponse.json({ error: "invalid_pin" }, { status: 400 });
  }

  const { rows } = await query<{ pin_hash: string | null }>(
    `SELECT pin_hash FROM users WHERE id = $1 AND business_id = $2`,
    [session.sub, session.businessId],
  );
  const hash = rows[0]?.pin_hash;
  if (!hash || !(await bcrypt.compare(pin, hash))) {
    await auditLoginFailure(session.businessId, session.sub, "invalid_pin_reverify");
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  return NextResponse.json({ ok: true });
});
