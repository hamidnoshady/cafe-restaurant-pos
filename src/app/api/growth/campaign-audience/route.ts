import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  audienceForDefinition,
  audienceForSegment,
  isCampaignChannel,
  unreachableForLackOfContact,
} from "@/lib/campaign-audience";
import { validateSegmentDefinition } from "@/lib/segments";

/**
 * Phase 36d — the Growth app asking the CRM "who should this campaign reach?".
 *
 * Deliberately lives under `/api/growth`, not `/api/crm`: the caller is the
 * Growth app, and the module gate that matters is the one on the app doing the
 * sending. The CRM owns the *answer* (rules, consent, member list); Growth owns
 * the question.
 *
 * A POST despite being a read, for the same reason as the segment preview: an
 * unsaved rule document does not survive a query string, and audience rules in
 * a URL end up in every access log. Nothing is written.
 *
 * Accepts either a saved `segmentId` or an ad-hoc `definition`. The response
 * always carries `matched` beside `reachable` so the send screen can explain
 * the gap rather than silently showing a smaller number.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.growthManage);
  if (error) return error;

  let body: { segmentId?: unknown; definition?: unknown; channel?: unknown; limit?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Fails closed: an unrecognised channel is rejected rather than defaulting.
  // Defaulting to "view" would mean *no consent filtering*, i.e. a send to
  // everyone including the people who refused — the exact failure this whole
  // path exists to prevent.
  if (!isCampaignChannel(body.channel)) {
    return NextResponse.json({ error: "campaign_channel_invalid" }, { status: 400 });
  }
  const channel = body.channel;

  const limit =
    typeof body.limit === "number" && Number.isFinite(body.limit) && body.limit > 0
      ? Math.floor(body.limit)
      : undefined;

  const audience = await (async () => {
    if (typeof body.segmentId === "string" && body.segmentId.trim() !== "") {
      return audienceForSegment(session.businessId, body.segmentId, channel, { limit });
    }
    if (body.definition !== undefined) {
      const problems = validateSegmentDefinition(body.definition);
      if (problems.length > 0) return { problems };
      return audienceForDefinition(
        session.businessId,
        body.definition as Parameters<typeof audienceForDefinition>[1],
        channel,
        { limit },
      );
    }
    return null;
  })();

  if (audience === null) {
    return NextResponse.json({ error: "segment_or_definition_required" }, { status: 400 });
  }
  if ("problems" in audience) {
    return NextResponse.json(
      { error: "segment_definition_invalid", problems: audience.problems },
      { status: 400 },
    );
  }

  // Consent granted but no phone/email on file is a data-quality problem the
  // owner can act on, and a different problem from a refusal. Counted
  // separately so the send screen can say so.
  const missingContact = unreachableForLackOfContact(audience.members, channel).length;

  return NextResponse.json({ audience: { ...audience, missingContact } });
});
