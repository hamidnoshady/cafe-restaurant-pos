import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { getSession, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { toLatinDigits } from "@/lib/digits";

/**
 * Phase 20 Wave 2 — confirms the caller's own PIN to dismiss the client-side
 * lock screen. Deliberately narrow: it re-checks the *already-authenticated*
 * caller's own `pin_hash` and nothing else — no new session is minted (the
 * existing one never stopped being valid; the screen was just visually
 * locked) and no other employee's PIN is ever accepted, so this is not a
 * second login path and needs no role list of its own.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  return NextResponse.json({ ok: true });
});
