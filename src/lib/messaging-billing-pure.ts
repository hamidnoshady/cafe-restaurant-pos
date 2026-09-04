/**
 * Phase 37 Wave 1 — the pure half of message billing.
 *
 * Persian SMS is UCS-2: a provider bills in fixed-length *segments*, and the
 * count is the whole cost. Get it wrong and a 71-character message silently
 * costs double with nobody told. That arithmetic lives here — pure, tested,
 * importable from anywhere (including a client screen that wants to show "this
 * message is 2 segments" before anyone presses send) — and never depends on a
 * database or a network.
 *
 * The one-line contract this module encodes, per #373: the first segment holds
 * 70 UCS-2 characters, each later segment 67 (the 3 removed are the segment
 * header). Email is charged flat regardless of body length.
 */

import type { CampaignChannel } from "./campaign-channels";

/** Characters in the first UCS-2 SMS segment. */
export const SMS_FIRST_SEGMENT_CHARS = 70;
/** Characters in each subsequent UCS-2 SMS segment. */
export const SMS_NEXT_SEGMENT_CHARS = 67;

/**
 * Number of SMS segments `text` will bill as.
 *
 * Character count is UTF-16 code units (`text.length`), which is exactly what a
 * UCS-2 provider counts, so an emoji in a supplementary plane is correctly two
 * units rather than one.
 */
export function smsSegmentCount(text: string): number {
  const chars = text.length;
  if (chars <= SMS_FIRST_SEGMENT_CHARS) return 1;
  return (
    1 + Math.ceil((chars - SMS_FIRST_SEGMENT_CHARS) / SMS_NEXT_SEGMENT_CHARS)
  );
}

export interface MessageRate {
  /** Rial per SMS *segment*. */
  smsRialPerSegment: number;
  /** Rial per email send, flat. */
  emailRialPerSend: number;
}

/**
 * Cost in Rial of sending `text` over `channel`, integer (never rounded mid
 * formula — segment count is exact and the product of integers stays an
 * integer).
 */
export function messageCostRial(
  channel: CampaignChannel,
  text: string,
  rate: MessageRate,
): number {
  if (channel === "sms") {
    return smsSegmentCount(text) * rate.smsRialPerSegment;
  }
  return rate.emailRialPerSend;
}

/** Cost in Rial of a single recipient line already rendered to `text`. */
export function recipientCostRial(
  channel: CampaignChannel,
  text: string,
  rate: MessageRate,
): number {
  return messageCostRial(channel, text, rate);
}

/** The running-total of segments a screen can show while composing. */
export function composeSegments(text: string): { segments: number; chars: number } {
  return { segments: smsSegmentCount(text), chars: text.length };
}
