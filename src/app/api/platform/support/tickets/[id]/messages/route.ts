import { NextRequest, NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { addSupportMessage, SupportTicketNotFoundError } from "@/lib/platform-service";
import { clientIpFrom } from "@/lib/rate-limit";
import { validateTicketInput } from "@/lib/support-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** The support desk's reply to a ticket. */
export const POST = withPlatformScope(async (request: NextRequest, ctx: Ctx) => {
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

  const text = typeof body.body === "string" ? body.body.trim() : "";
  const attachment = typeof body.attachment === "string" ? body.attachment : null;
  const validation = validateTicketInput({ body: text, attachment });
  if (validation.error) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  try {
    const message = await addSupportMessage({
      ticketId: id,
      adminId: session.padmin,
      body: text,
      attachment,
      ipAddress: (request as any).ip ?? clientIpFrom(request.headers, 0),
      userAgent: request.headers.get("user-agent"),
    });
    return NextResponse.json({ message }, { status: 201 });
  } catch (err) {
    if (err instanceof SupportTicketNotFoundError) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    throw err;
  }
});
