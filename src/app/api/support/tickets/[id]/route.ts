import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import {
  getMemberTicket,
  setMemberTicketStatus,
  TicketAccessError,
} from "@/lib/support-service";
import { isMemberSettableStatus } from "@/lib/support-tickets";

interface Ctx {
  params: Promise<{ id: string }>;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** One ticket and its full conversation, for the member who opened it (or an
 * owner/manager of the same business). */
export const GET = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requireMember();
  if (error) return error;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const ticket = await getMemberTicket({
    businessId: session.businessId,
    userId: session.sub,
    role: session.role,
    ticketId: id,
  });
  if (!ticket) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ticket });
});

/** The member-side lifecycle: close their ticket, or reopen it. */
export const PATCH = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requireMember();
  if (error) return error;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const status = typeof body.status === "string" ? body.status : "";
  if (!isMemberSettableStatus(status)) {
    return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  }

  try {
    await setMemberTicketStatus({
      businessId: session.businessId,
      userId: session.sub,
      role: session.role,
      ticketId: id,
      status,
    });
  } catch (err) {
    if (err instanceof TicketAccessError) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    throw err;
  }

  const ticket = await getMemberTicket({
    businessId: session.businessId,
    userId: session.sub,
    role: session.role,
    ticketId: id,
  });
  return NextResponse.json({ ticket });
});
