/**
 * Phase 36b — the Growth app's shared, framework-free pieces.
 *
 * `growth-overview.ts` reads the database, and the app's section screens are
 * client components: anything both of them need (the campaign life-cycle
 * classifier the dashboard and the campaigns list agree on, the window math,
 * the bridge account list) lives here, so a client import never drags `pg`
 * into the browser. Same posture as `promotions.ts` beside
 * `promotions-service.ts`: the pure half is importable everywhere, the
 * DB-touching half stays server-side.
 */

import { WELL_KNOWN_CODES } from "./coa-template";

/** The ledger accounts the Growth app writes to. This list *is* the app's accounting connection. */
export const GROWTH_BRIDGE_CODES = [
  WELL_KNOWN_CODES.salariesPayable, // 2300 — where commission accrues to
  WELL_KNOWN_CODES.storeCreditPayable, // 2410 — loyalty store credit
  WELL_KNOWN_CODES.giftCardPayable, // 2420 — gift cards
  WELL_KNOWN_CODES.commissionExpense, // 5210 — where commission is charged
] as const;

export type CampaignState = "live" | "scheduled" | "ended" | "paused";

export interface CampaignStateInput {
  isActive: boolean;
  activeFrom: string | null;
  activeTo: string | null;
}

/**
 * Where a campaign is in its life, from the stored date window (Gregorian ISO,
 * inclusive, the engine's own convention in `promotions.ts`). A paused
 * campaign keeps its window state out of the answer: «متوقف» says everything
 * the owner needs, and a campaign paused mid-window is not «در حال اجرا».
 */
export function classifyCampaign(campaign: CampaignStateInput, today: string): CampaignState {
  if (!campaign.isActive) return "paused";
  if (campaign.activeFrom && today < campaign.activeFrom) return "scheduled";
  if (campaign.activeTo && today > campaign.activeTo) return "ended";
  return "live";
}

export function campaignStateCounts(states: CampaignState[]): Record<CampaignState, number> {
  const counts: Record<CampaignState, number> = { live: 0, scheduled: 0, ended: 0, paused: 0 };
  for (const state of states) counts[state] += 1;
  return counts;
}

/**
 * An account's signed balance the way its side of the ledger reads it:
 * liabilities/equity/revenue are credit-normal, assets/expenses debit-normal.
 * A negative balance is a real answer (an over-redeemed liability), not a bug.
 */
export function accountBalance(type: string, debit: number, credit: number): number {
  return type === "asset" || type === "expense" ? debit - credit : credit - debit;
}

/** The same signed balance for PostgreSQL integer aggregates, without a lossy Number conversion. */
export function accountBalanceText(type: string, debit: string, credit: string): string {
  const result =
    type === "asset" || type === "expense" ? BigInt(debit) - BigInt(credit) : BigInt(credit) - BigInt(debit);
  return result.toString();
}

/** A rolling N-day window ending on `today`, inclusive on both ends. */
export function rollingWindow(today: string, days = 30): { from: string; to: string } {
  const to = new Date(`${today}T00:00:00Z`);
  to.setUTCDate(to.getUTCDate() - (days - 1));
  return { from: to.toISOString().slice(0, 10), to: today };
}
