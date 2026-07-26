import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { toLatinDigits } from "@/lib/digits";
import { isPinRole, isValidPin, sanitizeOverrides } from "@/lib/team";
import { TeamError, createMembership, isPinTaken, listMembers } from "@/lib/team-service";
import type { Role } from "@/lib/auth";

const ASSIGNABLE_ROLES: Role[] = ["owner", "manager", "accountant", "cashier", "waiter", "kitchen"];

/** The business's members, with their effective permissions resolved. */
export async function GET() {
  const { session, error } = await requirePermission(PERMISSIONS.teamManage);
  if (error) return error;

  return NextResponse.json({ members: await listMembers(session.businessId) });
}

/**
 * Adds a member directly.
 *
 * PIN staff are created outright — they work a shared device and have no email
 * to invite. Password roles can also be created directly (with a password, or
 * by linking an email that already has a platform login), but inviting is the
 * better path for those and is what the UI leads with.
 */
export async function POST(request: NextRequest) {
  const { session, error } = await requirePermission(PERMISSIONS.teamManage);
  if (error) return error;

  let body: {
    role?: Role;
    fullName?: string;
    email?: string;
    password?: string;
    pin?: string;
    locationIds?: string[];
    defaultLocationId?: string | null;
    permissions?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const role = body.role;
  if (!role || !ASSIGNABLE_ROLES.includes(role)) {
    return NextResponse.json({ error: "invalid_role" }, { status: 400 });
  }

  let pin: string | null = null;
  if (isPinRole(role)) {
    pin = body.pin ? toLatinDigits(String(body.pin)) : "";
    if (!isValidPin(pin)) return NextResponse.json({ error: "invalid_pin" }, { status: 400 });
    // PINs are bcrypt-hashed, so uniqueness can't be a constraint — it's
    // checked here, across the business (not, as before Phase 12, the world).
    if (await isPinTaken(session.businessId, pin)) {
      return NextResponse.json({ error: "pin_taken" }, { status: 409 });
    }
  }

  try {
    const { userId } = await createMembership({
      businessId: session.businessId,
      role,
      fullName: body.fullName ?? "",
      email: body.email ?? null,
      password: body.password ?? null,
      pin,
      locationIds: body.locationIds ?? [],
      defaultLocationId: body.defaultLocationId ?? null,
      overrides: sanitizeOverrides(body.permissions),
      actorId: session.sub,
    });
    return NextResponse.json({ id: userId }, { status: 201 });
  } catch (err) {
    if (err instanceof TeamError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
