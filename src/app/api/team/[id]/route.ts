import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { lockoutMessage, sanitizeOverrides } from "@/lib/team";
import {
  TeamError,
  removeMembership,
  setMemberPhone,
  updateMembership,
} from "@/lib/team-service";
import { canonicalMemberPhone } from "@/lib/phone-otp";
import type { Role } from "@/lib/auth";

const ASSIGNABLE_ROLES: Role[] = ["owner", "manager", "accountant", "cashier", "waiter", "kitchen"];

function errorResponse(err: unknown): NextResponse {
  if (err instanceof TeamError) {
    // The lockout refusal carries a Persian explanation; the UI shows it as-is.
    const reason = err.message === "last_owner" ? lockoutMessage("last_owner") : undefined;
    return NextResponse.json({ error: err.message, reason }, { status: err.status });
  }
  throw err;
}

/** Change a member's role, name, branches, permission overrides, or active state. */
export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.teamManage);
  if (error) return error;

  const { id } = await context.params;

  let body: {
    role?: Role;
    fullName?: string;
    isActive?: boolean;
    locationIds?: string[];
    defaultLocationId?: string | null;
    permissions?: unknown;
    /** Phase 42 — set (or, with "", clear) the member's login phone. Stored unverified. */
    phone?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.role !== undefined && !ASSIGNABLE_ROLES.includes(body.role)) {
    return NextResponse.json({ error: "invalid_role" }, { status: 400 });
  }

  // A phone change is its own action rather than a field on updateMembership:
  // it carries its own guards (mobile shape, per-business uniqueness) and its
  // own audit entry, and an owner typing somebody's number must never look
  // like a verified number.
  if (body.phone !== undefined) {
    const trimmed = String(body.phone).trim();
    const phone = trimmed ? canonicalMemberPhone(trimmed) : null;
    if (trimmed && !phone) {
      return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
    }
    try {
      await setMemberPhone(session.businessId, id, phone, session.sub);
    } catch (err) {
      return errorResponse(err);
    }
  }

  try {
    await updateMembership({
      businessId: session.businessId,
      userId: id,
      actorId: session.sub,
      role: body.role,
      fullName: body.fullName,
      isActive: body.isActive,
      locationIds: body.locationIds,
      defaultLocationId: body.defaultLocationId,
      overrides: body.permissions === undefined ? undefined : sanitizeOverrides(body.permissions),
    });
    /*
     * Same best-effort party as on create, and here for the repair case: a member
     * whose account was made before the party existed (or whose name was blank at
     * the time) gets their personnel file on the next edit of the membership. It
     * runs after the update has committed and its failure is not the member's
     * problem — the edit they asked for is already saved.
     */
    try {
      const { ensureEmployeeParty } = await import("@/lib/parties-service");
      await ensureEmployeeParty(session.businessId, id, {
        displayName: body.fullName?.trim() || null,
      });
    } catch {
      /* no party row for this member yet */
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
});

/**
 * Removes a member.
 *
 * Deactivates and strips credentials rather than deleting the row: every
 * foreign key to `users` is ON DELETE SET NULL, so a real delete would orphan
 * "who opened this order" throughout the ledger and audit trail.
 */
export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.teamManage);
  if (error) return error;

  const { id } = await context.params;
  try {
    await removeMembership(session.businessId, id, session.sub);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
});
