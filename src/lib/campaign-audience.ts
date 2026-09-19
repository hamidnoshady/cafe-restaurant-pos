/**
 * Phase 36d — the CRM → Growth bridge, the half that needs a database.
 *
 * Growth builds campaigns; the CRM knows who the customers are. Before this
 * module the two never spoke: a segment could be built, previewed and saved in
 * the CRM, and there was no way to hand it to the app whose whole job is
 * reaching people. This is that handoff.
 *
 * ## Why the audience resolves here and not in the Growth screens
 *
 * Reaching a customer is a *consent decision*, and consent is enforced in the
 * CRM service by design — never in a UI, never by a caller remembering to
 * filter. So Growth does not get the member list and then decide who to text.
 * It states a channel, and this module returns only the people reachable on
 * that channel, together with the number it excluded. The exclusion count is
 * returned rather than hidden because "your segment has 120 people but this
 * SMS reaches 43" is the single most important thing to show someone about to
 * press send, and a silently shrunken list looks like a bug.
 *
 * The channel constants and the pure arithmetic live in `campaign-channels.ts`
 * so client components can import them without pulling in `pg`.
 */

import {
  countDefinition,
  getSegment,
  resolveDefinition,
} from "./crm-segments-service";
import {
  AUDIENCE_LIMIT,
  CHANNEL_PURPOSE,
  summarizeAudienceCounts,
  type CampaignAudience,
  type CampaignChannel,
} from "./campaign-channels";
import type { SegmentDefinition } from "./segments";

export * from "./campaign-channels";

function audienceLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return AUDIENCE_LIMIT;
  return Math.min(Math.floor(value), AUDIENCE_LIMIT);
}

/**
 * Resolve a *saved* CRM segment into a sendable audience for one channel.
 *
 * Returns an empty audience for an unknown segment id rather than throwing: a
 * campaign screen pointed at a segment somebody archived should show "nobody"
 * and let the operator pick another, not 500.
 */
export async function audienceForSegment(
  businessId: string,
  segmentId: string,
  channel: CampaignChannel,
  options: { limit?: number } = {},
): Promise<CampaignAudience> {
  const limit = audienceLimit(options.limit);
  const segment = await getSegment(businessId, segmentId);
  if (!segment) return summarizeAudienceCounts(channel, 0, 0, [], limit);

  // Count with `COUNT(*)`, not by resolving the default member page. The old
  // path silently capped both numbers at 1,000, then sent only that capped page;
  // an audience of 1,350 consenting customers looked like 1,000 and lost 350.
  const purpose = CHANNEL_PURPOSE[channel];
  const [matched, reachable, members] = await Promise.all([
    countDefinition(businessId, segment.definition, "view"),
    countDefinition(businessId, segment.definition, purpose),
    resolveDefinition(businessId, segment.definition, { purpose, limit }),
  ]);
  return summarizeAudienceCounts(channel, matched, reachable, members, limit);
}

/** The same, for a definition that has not been saved yet — the "preview this send" path. */
export async function audienceForDefinition(
  businessId: string,
  definition: SegmentDefinition,
  channel: CampaignChannel,
  options: { limit?: number } = {},
): Promise<CampaignAudience> {
  const limit = audienceLimit(options.limit);
  const purpose = CHANNEL_PURPOSE[channel];
  const [matched, reachable, members] = await Promise.all([
    countDefinition(businessId, definition, "view"),
    countDefinition(businessId, definition, purpose),
    resolveDefinition(businessId, definition, { purpose, limit }),
  ]);
  return summarizeAudienceCounts(channel, matched, reachable, members, limit);
}
