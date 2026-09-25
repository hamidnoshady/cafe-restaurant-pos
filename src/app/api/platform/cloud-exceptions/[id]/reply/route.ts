import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { queueCloudExceptionResponse } from "@/lib/cloud-exception-relay";

export const POST = withPlatformScope(async (
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) => {
  const { session, error } = await requirePlatformCapability("support.manage");
  if (error) return error;
  let body: { body?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return NextResponse.json({ error: "bad_request" }, { status: 400 }); }
  const message = typeof body.body === "string" ? body.body.trim() : "";
  if (!message || message.length > 5000) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const { id } = await context.params;
  try {
    const response = await queueCloudExceptionResponse(id, session.padmin, message);
    await platformAudit({
      adminId: session.padmin,
      action: "cloud_exception.reply",
      entity: "cloud_exception",
      entityId: id,
      payload: { responseId: response.id },
    });
    return NextResponse.json(response, { status: 201 });
  } catch (cause) {
    const code = cause instanceof Error ? cause.message : "reply_failed";
    if (code === "cloud_exception_not_found") return NextResponse.json({ error: code }, { status: 404 });
    if (code === "response_not_supported") return NextResponse.json({ error: code }, { status: 409 });
    throw cause;
  }
});
