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

import { resolveDefinition, resolveSegment, getSegment } from "./crm-segments-service";
import {
  AUDIENCE_LIMIT,
  CHANNEL_PURPOSE,
  summarizeAudience,
  type CampaignAudience,
  type CampaignChannel,
} from "./campaign-channels";
import type { SegmentDefinition } from "./segments";

export * from "./campaign-channels";

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
  const limit = options.limit ?? AUDIENCE_LIMIT;
  const segment = await getSegment(businessId, segmentId);
  if (!segment) return summarizeAudience(channel, [], [], limit);

  // Two resolutions, deliberately: "view" is the unfiltered population and the
  // channel purpose is the reachable one. The difference is the number the
  // operator needs to see before sending.
  const matched = await resolveSegment(businessId, segmentId, { purpose: "view" });
  const reachable = await resolveSegment(businessId, segmentId, {
    purpose: CHANNEL_PURPOSE[channel],
  });
  return summarizeAudience(channel, matched, reachable, limit);
}

/** The same, for a definition that has not been saved yet — the "preview this send" path. */
export async function audienceForDefinition(
  businessId: string,
  definition: SegmentDefinition,
  channel: CampaignChannel,
  options: { limit?: number } = {},
): Promise<CampaignAudience> {
  const limit = options.limit ?? AUDIENCE_LIMIT;
  const matched = await resolveDefinition(businessId, definition, { purpose: "view" });
  const reachable = await resolveDefinition(businessId, definition, {
    purpose: CHANNEL_PURPOSE[channel],
  });
  return summarizeAudience(channel, matched, reachable, limit);
}
