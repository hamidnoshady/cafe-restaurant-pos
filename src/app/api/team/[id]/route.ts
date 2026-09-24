import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isLocationScope } from "@/lib/location-access";
import { lockoutMessage, sanitizeOverrides } from "@/lib/team";
import {
  TeamError,
  removeMembership,
  setMemberPhone,
  updateMembership,
} from "@/lib/team-service";
import { canonicalMemberPhone } from "@/lib/phone-otp";
import { query } from "@/lib/db";
import type { Role } from "@/lib/auth";

const ASSIGNABLE_ROLES: Role[] = ["owner", "admin", "manager", "accountant", "cashier", "waiter", "kitchen", "viewer"];

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
    /** 'all' | 'selected' | 'home' — the explicit branch policy (migration 0170). */
    locationScope?: string;
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
  // Refused rather than ignored: silently dropping an unrecognised scope would
  // leave the member on a policy the caller did not ask for and believes they
  // changed.
  if (body.locationScope !== undefined && !isLocationScope(body.locationScope)) {
    return NextResponse.json({ error: "invalid_location_scope" }, { status: 400 });
  }

  // Changing WHAT somebody may do is a different act from administering them,
  // and needs the key carved out for it. `team.manage` alone covers creating
  // staff, renaming them, moving them between branches, suspending them and
  // resetting their credentials; handing out capability is how a delegated
  // team administrator would escalate their own access, so it is gated
  // separately. Only the fields that actually change access are affected —
  // a suspend, a rename or a branch move still needs nothing more than
  // `team.manage`, so nobody's existing workflow breaks.
  if (body.role !== undefined || body.permissions !== undefined) {
    const escalation = await requirePermission(PERMISSIONS.teamPermissionsManage);
    if (escalation.error) return escalation.error;
  }

  // Managing routine team details may be delegated; managing an owner or
  // granting ownership may not. Enforce this server-side, not merely in UI.
  const { rows: roleRows } = await query<{ actor_role: Role; target_role: Role }>(
    `SELECT actor.role AS actor_role, target.role AS target_role
       FROM users actor
       JOIN users target ON target.id = $3 AND target.business_id = actor.business_id
      WHERE actor.id = $1 AND actor.business_id = $2 AND actor.is_active = true`,
    [session.sub, session.businessId, id],
  );
  const roles = roleRows[0];
  if (!roles) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (roles.actor_role !== "owner" && (roles.target_role === "owner" || body.role === "owner")) {
    return NextResponse.json({ error: "owner_only" }, { status: 403 });
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
      locationScope: isLocationScope(body.locationScope) ? body.locationScope : undefined,
      overrides: body.permissions === undefined ? undefined : sanitizeOverrides(body.permissions),
    });
    /*
     * Same best-effort party as on create, and here for the repair case: a member
     * whose account was made before the party existed (or whose name was blank at
     * the time) gets their personnel file on the next edit of the membership. It
     * runs after the update has committed and its failure is not the member's
     * problem — the edit they asked for is already saved.
     *
     * Only a request that actually names the member renames the file: the call
     * doubles as the repair path in parties-service now (it updates an existing
     * party's name, not just creates the missing one), and a suspend or a
     * permission change — which sends no name — must not stamp the party with
     * whatever stale label the body happened to omit.
     */
    const renameTo = body.fullName?.trim();
    if (renameTo) {
      try {
        const { ensureEmployeeParty } = await import("@/lib/parties-service");
        await ensureEmployeeParty(session.businessId, id, { displayName: renameTo });
      } catch {
        /* no party row for this member yet */
      }
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
  const { rows } = await query<{ actor_role: Role; target_role: Role }>(
    `SELECT actor.role AS actor_role, target.role AS target_role FROM users actor
       JOIN users target ON target.id = $3 AND target.business_id = actor.business_id
      WHERE actor.id = $1 AND actor.business_id = $2 AND actor.is_active = true`,
    [session.sub, session.businessId, id],
  );
  if (!rows[0]) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (rows[0].actor_role !== "owner" && rows[0].target_role === "owner") {
    return NextResponse.json({ error: "owner_only" }, { status: 403 });
  }
  try {
    await removeMembership(session.businessId, id, session.sub);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
});
