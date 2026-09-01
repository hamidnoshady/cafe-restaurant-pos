import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import {
  createMemberTicket,
  listMemberTickets,
  validateTicketInput,
  SUPPORT_SUBJECT_MAX,
  SUPPORT_BODY_MAX,
} from "@/lib/support-service";
import { isTicketCategory, isTicketPriority } from "@/lib/support-tickets";

/**
 * The member's support tickets (migration 0130).
 *
 * Any signed-in member may open a ticket — asking for help is not a privileged
 * act, so `requireMember` (not `requireRole`) gates both routes, and the
 * service scopes everything to the session's business and user. `businessId`,
 * `userId` and `role` come from the session, never from the body.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireMember();
  if (error) return error;

  const searchParams = request.nextUrl.searchParams;
  const rawLimit = Number(searchParams.get("limit"));

  return NextResponse.json({
    tickets: await listMemberTickets({
      businessId: session.businessId,
      userId: session.sub,
      role: session.role,
      status: searchParams.get("status") ?? "",
      limit: Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 200,
    }),
  });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireMember();
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const subject = typeof body.subject === "string" ? body.subject.trim().slice(0, SUPPORT_SUBJECT_MAX) : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const attachment = typeof body.attachment === "string" ? body.attachment : null;
  const category = typeof body.category === "string" ? body.category : "other";
  const priority = typeof body.priority === "string" ? body.priority : "normal";

  const validation = validateTicketInput({ subject, body: description, attachment });
  if (validation.error) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const ticket = await createMemberTicket({
    businessId: session.businessId,
    locationId: session.locationId ?? null,
    userId: session.sub,
    subject,
    category: isTicketCategory(category) ? category : "other",
    priority: isTicketPriority(priority) ? priority : "normal",
    body: description,
    attachment,
  });

  return NextResponse.json({ ticket }, { status: 201 });
});
