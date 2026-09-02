import { NextRequest, NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import {
  getSupportTicket,
  SupportTicketNotFoundError,
  updateSupportTicket,
} from "@/lib/platform-service";
import { clientIpFrom } from "@/lib/rate-limit";

interface Ctx {
  params: Promise<{ id: string }>;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** One ticket with its full conversation. */
export const GET = withPlatformScope(async (_request: NextRequest, ctx: Ctx) => {
  const { error } = await requirePlatformCapability("support.manage");
  if (error) return error;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const ticket = await getSupportTicket(id);
  if (!ticket) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ticket });
});

/** The console's lifecycle controls: status, priority, category, assignment. */
export const PATCH = withPlatformScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePlatformCapability("support.manage");
  if (error) return error;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  try {
    const ticket = await updateSupportTicket({
      ticketId: id,
      adminId: session.padmin,
      status: typeof body.status === "string" ? body.status : undefined,
      priority: typeof body.priority === "string" ? body.priority : undefined,
      category: typeof body.category === "string" ? body.category : undefined,
      assignedAdminId:
        body.assignedAdminId === null || typeof body.assignedAdminId === "string"
          ? (body.assignedAdminId as string | null)
          : undefined,
      ipAddress: (request as any).ip ?? clientIpFrom(request.headers, 0),
      userAgent: request.headers.get("user-agent"),
    });
    return NextResponse.json({ ticket });
  } catch (err) {
    if (err instanceof SupportTicketNotFoundError) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (err instanceof Error && err.message === "invalid_status") {
      return NextResponse.json({ error: "invalid_status" }, { status: 400 });
    }
    if (err instanceof Error && err.message === "invalid_priority") {
      return NextResponse.json({ error: "invalid_priority" }, { status: 400 });
    }
    if (err instanceof Error && err.message === "invalid_category") {
      return NextResponse.json({ error: "invalid_category" }, { status: 400 });
    }
    if (err instanceof Error && err.message === "invalid_assignee") {
      return NextResponse.json({ error: "invalid_assignee" }, { status: 400 });
    }
    throw err;
  }
});
