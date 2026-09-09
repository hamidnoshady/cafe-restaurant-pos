import { NextRequest, NextResponse } from "next/server";
import { query, withTenant, withoutTenantScope } from "@/lib/db";
import { requestHost } from "@/lib/host";
import { checkLoginLockout, resolveLoginBusinessId } from "@/lib/employee-service";
import {
  canonicalMemberPhone,
  maskPhoneE164,
  sendEmployeePhoneOtp,
  signPhonePendingToken,
  verifyPhonePendingToken,
} from "@/lib/phone-otp";
import { KavenegarError } from "@/lib/sms-kavenegar";

interface MemberRow extends Record<string, unknown> {
  id: string;
  full_name: string;
  phone_e164: string | null;
}

/**
 * Phase 42 — start a phone-OTP login: mint the challenge and dispatch the
 * code through Kavenegar. One route, three ways in, and the difference
 * between them is exactly how much has been proven:
 *
 *  1. **Bearer `phone_pending` token** (the PIN-verified step of
 *     `/api/auth/pin-login`) — the member's PIN is proven, so a *new* number
 *     may be attached (first-time verify: nothing on file yet) or the stored
 *     number may be (re)verified.
 *  2. **`employeeId`** (a name picked from the roster, no PIN) — only the
 *     number already on file may be challenged; the OTP itself is the
 *     credential, so "pick a name, type any number" must not be possible.
 *  3. **`phone`** (the door's «ورود با شمارهٔ موبایل» tab) — resolves the
 *     member by number; only a *verified* number can log in, because an
 *     owner-typed-but-unproven number must never become a login credential
 *     by itself.
 *
 * Case 3 answers a number that matches nothing exactly as it answers one
 * that does (a token whose verify can never succeed, no SMS sent) — a door
 * that reads "wrong number" out loud is a free member-number oracle, and the
 * roster already publishes enough names as it is.
 */
export async function POST(request: NextRequest) {
  let body: { employeeId?: string; phone?: string; businessId?: string; businessSlug?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";

  // ------------------------------------------------------------------ 1. PIN-verified continuation
  if (bearer) {
    const payload = await verifyPhonePendingToken(bearer);
    if (!payload?.sub) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return withTenant(payload.businessId, async () => {
      const lockout = await checkLoginLockout(payload.businessId!, payload.sub!);
      if (lockout.locked) {
        return NextResponse.json(
          { error: "account_locked", lockedUntil: lockout.lockedUntil },
          { status: 423 },
        );
      }

      const { rows } = await query<MemberRow>(
        `SELECT id, full_name, phone_e164 FROM users
          WHERE id = $1 AND business_id = $2 AND is_active`,
        [payload.sub, payload.businessId],
      );
      const member = rows[0];
      if (!member) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

      let phone: string | null = member.phone_e164;
      if (payload.mayAttachPhone && body.phone) {
        const candidate = canonicalMemberPhone(body.phone);
        if (!candidate) return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
        // A candidate typed at this step still needs the OTP below to stick;
        // storing it happens in verify, not here.
        phone = candidate;
      }
      if (!phone) return NextResponse.json({ error: "phone_missing" }, { status: 400 });

      const token = await signPhonePendingToken({
        sub: member.id,
        businessId: payload.businessId!,
        mayAttachPhone: payload.mayAttachPhone,
        phone: phone !== member.phone_e164 ? phone : null,
      });

      return dispatchOrError({
        businessId: payload.businessId!,
        userId: member.id,
        phone,
        token,
      });
    });
  }

  // ------------------------------------------------------------------ 2. roster pick → stored number
  if (body.employeeId) {
    const { businessId, error } = await resolveLoginBusinessId({
      ...body,
      host: requestHost(request.headers),
    });
    if (!businessId) {
      return NextResponse.json({ error: error ?? "unknown_business" }, { status: 400 });
    }

    return withTenant(businessId, async () => {
      const lockout = await checkLoginLockout(businessId, body.employeeId!);
      if (lockout.locked) {
        return NextResponse.json(
          { error: "account_locked", lockedUntil: lockout.lockedUntil },
          { status: 423 },
        );
      }

      const { rows } = await query<MemberRow>(
        `SELECT id, full_name, phone_e164 FROM users
          WHERE id = $1 AND business_id = $2 AND is_active`,
        [body.employeeId, businessId],
      );
      const member = rows[0];
      if (!member) return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
      if (!member.phone_e164) {
        return NextResponse.json({ error: "phone_missing" }, { status: 400 });
      }

      const token = await signPhonePendingToken({
        sub: member.id,
        businessId,
        mayAttachPhone: false,
        phone: null,
      });
      return dispatchOrError({
        businessId,
        userId: member.id,
        phone: member.phone_e164,
        token,
      });
    });
  }

  // ------------------------------------------------------------------ 3. direct phone login
  const phone = canonicalMemberPhone(body.phone);
  if (!phone) return NextResponse.json({ error: "invalid_phone" }, { status: 400 });

  const { businessId, error } = await resolveLoginBusinessId({
    ...body,
    host: requestHost(request.headers),
  });

  if (businessId) {
    return withTenant(businessId, async () => {
      const { rows } = await query<MemberRow>(
        `SELECT id, full_name, phone_e164 FROM users
          WHERE business_id = $1 AND phone_e164 = $2 AND is_active
            AND phone_verified_at IS NOT NULL`,
        [businessId, phone],
      );
      const member = rows[0];
      if (!member) return antiEnumerationResponse(phone);

      const lockout = await checkLoginLockout(businessId, member.id);
      if (lockout.locked) {
        return NextResponse.json(
          { error: "account_locked", lockedUntil: lockout.lockedUntil },
          { status: 423 },
        );
      }

      const token = await signPhonePendingToken({
        sub: member.id,
        businessId,
        mayAttachPhone: false,
        phone: null,
      });
      return dispatchOrError({ businessId, userId: member.id, phone, token });
    });
  }

  // No origin named a business (a single-box install without host routing).
  // The number itself may still name exactly one member — the password login's
  // `needsBusinessSelection` shape, answered for a phone. Cross-tenant by
  // nature, like /api/auth/login, and on the same documented bypass.
  if (error === "business_required") {
    return withoutTenantScope("login", async () => {
      const { rows } = await query<{ id: string; full_name: string; business_id: string; business_name: string }>(
        `SELECT u.id, u.full_name, u.business_id, b.name AS business_name
           FROM users u
           JOIN businesses b ON b.id = u.business_id
          WHERE u.phone_e164 = $1 AND u.is_active
            AND u.phone_verified_at IS NOT NULL
            AND b.status = 'active'`,
        [phone],
      );
      if (rows.length === 0) return antiEnumerationResponse(phone);
      if (rows.length > 1) {
        return NextResponse.json({
          needsBusinessSelection: true,
          businesses: rows.map((r) => ({ id: r.business_id, name: r.business_name })),
        });
      }
      const member = rows[0];
      const token = await signPhonePendingToken({
        sub: member.id,
        businessId: member.business_id,
        mayAttachPhone: false,
        phone: null,
      });
      return dispatchOrError({
        businessId: member.business_id,
        userId: member.id,
        phone,
        token,
      });
    });
  }

  return NextResponse.json({ error: error ?? "unknown_business" }, { status: 400 });
}

/**
 * Send the code, or translate the failure. Shared by all three modes so the
 * Kavenegar user-fault/operator-fault split (see the challenge route's twin
 * comment) is decided in exactly one place.
 */
async function dispatchOrError(options: {
  businessId: string;
  userId: string;
  phone: string;
  token: string;
}): Promise<NextResponse> {
  try {
    const sent = await sendEmployeePhoneOtp({
      businessId: options.businessId,
      userId: options.userId,
      phone: options.phone,
    });
    if (!sent.allowed) {
      return NextResponse.json(
        { error: "rate_limited", retryAfterMs: sent.retryAfterMs },
        { status: 429 },
      );
    }
  } catch (err) {
    console.error("Phone-OTP dispatch failed", err);
    // Only the half of a Kavenegar failure the member can *act on* is theirs
    // to see; an operator-side fault (empty credit, bad key) stays generic so
    // the member is not sent re-typing a number that was never the problem.
    const message =
      err instanceof KavenegarError && !err.operatorFault ? err.message : undefined;
    return NextResponse.json({ error: "sms_dispatch_failed", message }, { status: 502 });
  }

  return NextResponse.json({ status: "sent", maskedPhone: maskPhoneE164(options.phone), token: options.token });
}

/**
 * The answer to a number nothing matches: byte-identical to success minus a
 * code ever being sent. The token carries no subject, so its verify can only
 * ever say «کد درست نیست» — the shape holds, the oracle doesn't.
 */
async function antiEnumerationResponse(phone: string): Promise<NextResponse> {
  const token = await signPhonePendingToken({
    sub: null,
    businessId: "00000000-0000-0000-0000-000000000000",
    mayAttachPhone: false,
    phone: null,
  });
  return NextResponse.json({ status: "sent", maskedPhone: maskPhoneE164(phone), token });
}
