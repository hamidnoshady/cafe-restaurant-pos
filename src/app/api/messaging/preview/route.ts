import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { audienceForSegment } from "@/lib/campaign-audience";
import { query } from "@/lib/db";
import { getMessageTemplate, buildMessageVariables, renderRecipientBody } from "@/lib/message-campaigns-service";
import { getPublicMessageConfig } from "@/lib/messaging-billing";
import { messageCostRial, smsSegmentCount } from "@/lib/messaging-billing-pure";

/**
 * Renders a selected template against one actual, consent-eligible member of
 * the selected segment. This is a preview only: it writes no recipient/outbox
 * row and intentionally returns no phone/email address to the browser.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const body = await request.json().catch(() => null) as { templateId?: unknown; segmentId?: unknown } | null;
  if (!body || typeof body.templateId !== "string" || typeof body.segmentId !== "string") {
    return NextResponse.json({ error: "template_and_segment_required" }, { status: 400 });
  }
  const template = await getMessageTemplate(session.businessId, body.templateId);
  if (!template) return NextResponse.json({ error: "template_not_found" }, { status: 404 });
  const audience = await audienceForSegment(session.businessId, body.segmentId, template.channel, { limit: 1 });
  const member = audience.members[0];
  if (!member) return NextResponse.json({ error: "no_reachable_customer" }, { status: 400 });

  const [{ rows: businesses }, { rows: pointsRows }, config] = await Promise.all([
    query<{ name: string }>(`SELECT name FROM businesses WHERE id = $1`, [session.businessId]),
    query<{ points: string | number }>(`SELECT coalesce(sum(points), 0) AS points FROM customer_points WHERE business_id = $1 AND customer_id = $2`, [session.businessId, member.id]),
    getPublicMessageConfig(),
  ]);
  try {
    const values = buildMessageVariables({ name: member.name, shopName: businesses[0]?.name ?? "", points: Number(pointsRows[0]?.points ?? 0) });
    const renderedBody = renderRecipientBody(template.body, values);
    const subject = template.channel === "email" ? renderRecipientBody(template.subject, values) : "";
    return NextResponse.json({
      preview: {
        customerName: member.name, channel: template.channel, subject, body: renderedBody,
        smsSegments: template.channel === "sms" ? smsSegmentCount(renderedBody) : null,
        costRial: messageCostRial(template.channel, renderedBody, config.rate),
        matched: audience.matched, reachable: audience.reachable, excluded: audience.excludedByConsent,
      },
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "preview_failed";
    if (message.startsWith("message_variable_missing")) return NextResponse.json({ error: message }, { status: 400 });
    throw cause;
  }
});
