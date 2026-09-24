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

/**
 * The life-cycle states, in the order every Growth surface presents them:
 * what is running, what is coming, what is held, what is over.
 *
 * `growth-overview.ts` sorted its campaign list by a private `STATE_ORDER`
 * map, the dashboard hard-coded the same four keys inline to draw its badge
 * row, and the campaigns list spelled them a third time in its filter bar.
 * One ordered list means a fifth state cannot be added to some of them.
 */
export const CAMPAIGN_STATES = ["live", "scheduled", "paused", "ended"] as const;

export type CampaignState = (typeof CAMPAIGN_STATES)[number];

export interface CampaignStateInput {
  isActive: boolean;
  activeFrom: string | null;
  activeTo: string | null;
}

/**
 * The four tones `StatusBadge` draws, named here so this framework-free module
 * can carry the campaign vocabulary without importing a React component.
 */
export type CampaignStateTone = "active" | "positive" | "neutral" | "danger";

/**
 * What each life-cycle state is called, in the app's own words.
 *
 * One list, every screen. The dashboard and the campaigns list each used to
 * keep a private copy, which is how the same campaign came to be labelled from
 * two tables that nothing kept in step.
 */
export const CAMPAIGN_STATE_LABELS: Record<CampaignState, string> = {
  live: "در حال اجرا",
  scheduled: "زمان‌بندی‌شده",
  ended: "پایان‌یافته",
  paused: "متوقف",
};

/**
 * The badge tone each state is drawn in, in the design system's vocabulary:
 * amber («active») is work in progress, emerald («positive») is ready and
 * healthy, stone («neutral») is no longer relevant.
 *
 * The two copies this replaces genuinely disagreed — the dashboard painted a
 * running campaign emerald and a scheduled one amber, while the campaigns list
 * did the exact opposite, so one campaign changed colour depending on which
 * screen you opened. «متوقف» is a deliberate pause, not a fault, so it is
 * neutral rather than red.
 */
export const CAMPAIGN_STATE_TONES: Record<CampaignState, CampaignStateTone> = {
  live: "active",
  scheduled: "positive",
  paused: "neutral",
  ended: "neutral",
};

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

/**
 * How many campaigns sit in each state. Seeded from `CAMPAIGN_STATES` rather
 * than a hand-written object literal, so a new state is counted everywhere the
 * moment it is added to the list — the campaigns list built this same tally
 * inline from its own literal, which is one more place to forget.
 */
export function campaignStateCounts(
  states: readonly CampaignState[],
): Record<CampaignState, number> {
  const counts = Object.fromEntries(CAMPAIGN_STATES.map((state) => [state, 0])) as Record<
    CampaignState,
    number
  >;
  for (const state of states) counts[state] += 1;
  return counts;
}

/**
 * The presentation order of a state — `CAMPAIGN_STATES`'s own index, so the
 * dashboard's campaign list sorts by the same order the filter bar offers.
 */
export function campaignStateOrder(state: CampaignState): number {
  return CAMPAIGN_STATES.indexOf(state);
}

/**
 * An account's signed balance the way its side of the ledger reads it:
 * liabilities/equity/revenue are credit-normal, assets/expenses debit-normal.
 * A negative balance is a real answer (an over-redeemed liability), not a bug.
 */
export function accountBalance(type: string, debit: number, credit: number): number {
  return type === "asset" || type === "expense" ? debit - credit : credit - debit;
}

// The window maths is `date-window.ts`'s — neither this app nor the CRM owns
// "the last 30 days", and the two apps used to keep identical copies of it.
// Re-exported here so every existing Growth caller keeps its one import.
export { rollingWindow } from "./date-window";
