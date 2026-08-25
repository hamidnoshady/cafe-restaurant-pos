import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { listNotificationInbox, markNotificationsRead } from "@/lib/notifications-service";

/** The bell: what this member was told, newest first, plus the unread count. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const guard = await requireMember();
  if (guard.error) return guard.error;

  const limit = Number(request.nextUrl.searchParams.get("limit") ?? 50);
  const inbox = await listNotificationInbox(
    guard.session.businessId,
    guard.session.sub,
    Number.isFinite(limit) ? limit : 50,
  );
  return NextResponse.json(inbox);
});

/** Marks one entry read, or every unread one when no id is given. */
export const PATCH = withTenantScope(async (request: NextRequest) => {
  const guard = await requireMember();
  if (guard.error) return guard.error;

  let body: { id?: string } = {};
  try {
    body = (await request.json()) as { id?: string };
  } catch {
    // An empty body is the "mark everything read" case, not an error.
  }

  const updated = await markNotificationsRead(guard.session.businessId, guard.session.sub, body.id);
  return NextResponse.json({ updated });
});
