/**
 * Phase 36d — the client-safe half of the CRM → Growth bridge.
 *
 * Split out from `campaign-audience.ts` for one concrete reason: that module
 * imports `crm-segments-service`, which imports `db`, which imports `pg`. A
 * client component importing a channel label from it drags the Postgres driver
 * into the browser bundle and the production build fails outright.
 *
 * So the *decisions* (which channels exist, what they are called, which consent
 * purpose each maps to, what a member's contact detail is) live here, pure and
 * importable from anywhere, and the resolution that needs a database stays next
 * door.
 */

import type { SegmentPurpose } from "./segments";

/** The ways a campaign can actually reach somebody. */
export const CAMPAIGN_CHANNELS = ["sms", "email"] as const;
export type CampaignChannel = (typeof CAMPAIGN_CHANNELS)[number];

export const CAMPAIGN_CHANNEL_LABELS: Record<CampaignChannel, string> = {
  sms: "پیامک",
  email: "ایمیل",
};

/**
 * Channel → the consent purpose the segment compiler understands.
 *
 * Kept as an explicit map rather than a cast so that adding a channel without
 * deciding its consent rule is a compile error, not a silent "view" (which
 * means *no consent filtering at all* and would broadcast to everyone).
 */
export const CHANNEL_PURPOSE: Record<CampaignChannel, SegmentPurpose> = {
  sms: "sms",
  email: "email",
};

export function isCampaignChannel(value: unknown): value is CampaignChannel {
  return typeof value === "string" && (CAMPAIGN_CHANNELS as readonly string[]).includes(value);
}

/** Default cap. Generous enough for a real send, small enough not to page a whole customer base into memory by accident. */
export const AUDIENCE_LIMIT = 5_000;

export interface CampaignAudience {
  channel: CampaignChannel;
  /** Everyone the rules matched, before consent was applied. */
  matched: number;
  /** Who is actually reachable on this channel. */
  reachable: number;
  /**
   * `matched - reachable`. Surfaced so the send screen can say why the number
   * shrank instead of leaving the operator to guess.
   */
  excludedByConsent: number;
  /** The reachable members themselves, capped by `limit`. */
  members: AudienceMember[];
  /** True when the cap truncated the list — the caller must not treat `members.length` as the audience size. */
  truncated: boolean;
}

/** The subset of a segment member this bridge reasons about. Structural, so `SegmentMember` satisfies it without importing the DB module. */
export interface AudienceMember {
  id: string;
  name: string;
  phone: string | null;
  phoneE164: string | null;
  email: string | null;
  smsConsent: boolean;
  marketingConsent: boolean;
}

/**
 * The contact detail a channel actually sends to, or null when the member has
 * no usable address. Consent is necessary but not sufficient — somebody can
 * have granted SMS consent and have no phone number on file.
 */
export function contactFor<T extends AudienceMember>(member: T, channel: CampaignChannel): string | null {
  if (channel === "sms") return member.phoneE164 ?? member.phone ?? null;
  const email = member.email?.trim();
  return email ? email : null;
}

/** Members with consent but no address — worth showing as a data-quality warning rather than dropping silently. */
export function unreachableForLackOfContact<T extends AudienceMember>(
  members: readonly T[],
  channel: CampaignChannel,
): T[] {
  return members.filter((m) => contactFor(m, channel) === null);
}

/** Assemble the counts. Pure, so the arithmetic that matters is unit-testable without a database. */
export function summarizeAudience<T extends AudienceMember>(
  channel: CampaignChannel,
  matchedMembers: readonly T[],
  reachableMembers: readonly T[],
  limit: number,
): CampaignAudience {
  const matched = matchedMembers.length;
  const reachable = reachableMembers.length;
  return {
    channel,
    matched,
    reachable,
    // Clamped at zero: consent can only ever narrow the audience, so a negative
    // here would mean the two queries disagreed about the population, and
    // reporting "-3 excluded" would be worse than reporting 0.
    excludedByConsent: Math.max(0, matched - reachable),
    members: reachableMembers.slice(0, limit),
    truncated: reachable > limit,
  };
}
