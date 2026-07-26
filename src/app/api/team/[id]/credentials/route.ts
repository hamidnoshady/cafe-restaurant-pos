import { NextRequest, NextResponse } from "next/server";
import { getSession, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { toLatinDigits } from "@/lib/digits";
import { isValidPin } from "@/lib/team";
import { TeamError, setPassword, setPin, verifyPassword } from "@/lib/team-service";

/**
 * Sets a member's PIN or password.
 *
 * Two callers, deliberately in one route because the rules differ only by who
 * is asking:
 *
 *   - **Yourself** — allowed without `team.manage`, but you must prove your
 *     current password before changing it. Otherwise a walk-up at an unlocked
 *     screen becomes a permanent account takeover.
 *   - **Someone else** — requires `team.manage`, and no current password
 *     (that's the point of a force-reset).
 *
 * Note that a password lives on the *global* identity, so an owner resetting a
 * member's password changes that person's login everywhere they are a member,
 * not only here. A PIN is per-membership and stays local to this business.
 */
export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const isSelf = id === session.sub;

  if (!isSelf) {
    const guard = await requirePermission(PERMISSIONS.teamManage);
    if (guard.error) return guard.error;
  }

  let body: { pin?: string; password?: string; currentPassword?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    if (body.pin !== undefined) {
      const pin = toLatinDigits(String(body.pin));
      if (!isValidPin(pin)) return NextResponse.json({ error: "invalid_pin" }, { status: 400 });
      await setPin(session.businessId, id, pin, session.sub);
      return NextResponse.json({ ok: true });
    }

    if (body.password !== undefined) {
      if (isSelf && !(await verifyPassword(session.sub, body.currentPassword ?? ""))) {
        return NextResponse.json({ error: "invalid_current_password" }, { status: 403 });
      }
      await setPassword(session.businessId, id, body.password, session.sub);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "nothing_to_change" }, { status: 400 });
  } catch (err) {
    if (err instanceof TeamError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
