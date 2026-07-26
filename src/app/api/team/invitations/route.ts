import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isPasswordRole, sanitizeOverrides } from "@/lib/team";
import { TeamError, createInvitation, listInvitations } from "@/lib/team-service";
import type { Role } from "@/lib/auth";

export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.teamManage);
  if (error) return error;

  return NextResponse.json({ invitations: await listInvitations(session.businessId) });
});

/**
 * Invites someone to join this business.
 *
 * Returns the token exactly once, as a link for the owner to pass on — no
 * email is sent (Phase 13 decision: there is no mail transport in this system,
 * and adding one is a deployment concern). Only the token's hash is stored, so
 * it cannot be recovered afterwards; re-inviting issues a fresh one and
 * supersedes any invitation still pending for that address.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.teamManage);
  if (error) return error;

  let body: {
    email?: string;
    fullName?: string;
    role?: Role;
    locationIds?: string[];
    permissions?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }
  // PIN roles work a shared device and have no email — they're created
  // directly on /api/team instead.
  if (!body.role || !isPasswordRole(body.role)) {
    return NextResponse.json({ error: "role_not_invitable" }, { status: 400 });
  }

  try {
    const { token, invitationId } = await createInvitation({
      businessId: session.businessId,
      email,
      role: body.role,
      fullName: body.fullName ?? "",
      locationIds: body.locationIds ?? [],
      overrides: sanitizeOverrides(body.permissions),
      actorId: session.sub,
    });

    const url = new URL(`/invite/${token}`, request.nextUrl.origin).toString();
    return NextResponse.json({ id: invitationId, token, url }, { status: 201 });
  } catch (err) {
    if (err instanceof TeamError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
