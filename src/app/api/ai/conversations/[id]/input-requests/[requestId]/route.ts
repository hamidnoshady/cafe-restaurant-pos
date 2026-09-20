import { NextRequest, NextResponse } from "next/server";
import { getSession, withTenantScope } from "@/lib/auth";
import { ownsConversation } from "@/lib/ai-conversations";
import { answerInputRequest, cancelInputRequest } from "@/lib/ai-input-requests-service";

/**
 * Phase E — answer a structured input request. The submitted response is
 * re-validated against the stored spec (never the client's word for it), the
 * request is marked answered, and the plain-text `modelMessage` is returned —
 * labels not ids — for the client to send as its next chat turn. The status
 * transition is atomic, so a double submit reports `already_answered` rather
 * than writing twice.
 *
 * Access control is conversation OWNERSHIP (not role), exactly like the rest of
 * the conversation surface: a request reaches tenant scope only through its
 * parent conversation.
 */
export const POST = withTenantScope(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string; requestId: string }> },
  ) => {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id, requestId } = await context.params;

    const owns = await ownsConversation({
      businessId: session.businessId,
      actorUserId: session.sub,
      conversationId: id,
    });
    if (!owns) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const body = (await request.json().catch(() => ({}))) as { response?: unknown };
    const result = await answerInputRequest({
      conversationId: id,
      id: requestId,
      response: body.response,
    });

    if (!result.ok) {
      const status = result.error === "not_found" ? 404 : result.error === "already_answered" ? 409 : 400;
      return NextResponse.json({ error: result.error, details: result.details }, { status });
    }
    return NextResponse.json({ request: result.request, modelMessage: result.modelMessage });
  },
);

/** Dismiss a pending input request without answering it. Idempotent. */
export const DELETE = withTenantScope(
  async (
    _request: NextRequest,
    context: { params: Promise<{ id: string; requestId: string }> },
  ) => {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id, requestId } = await context.params;

    const owns = await ownsConversation({
      businessId: session.businessId,
      actorUserId: session.sub,
      conversationId: id,
    });
    if (!owns) return NextResponse.json({ error: "not_found" }, { status: 404 });

    await cancelInputRequest(id, requestId);
    return NextResponse.json({ ok: true });
  },
);
