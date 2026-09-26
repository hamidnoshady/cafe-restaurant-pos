/**
 * Explicit subscription transition rules.
 *
 * A customer purchase enables auto-renew. An admin assignment preserves the
 * current flag unless the caller sets it. A trial starts in `trialing` and
 * can be taken only once per business.
 */

export type PlanChangeSource = "admin" | "purchase" | "trial";

export type SubscriptionLifeStatus = "trialing" | "active" | "past_due" | "cancelled" | "expired";

export interface CurrentSubscriptionState {
  status: SubscriptionLifeStatus;
  autoRenew: boolean;
  trialStartedAt: string | null;
  trialEnd: string | null;
  planKey: string;
}

export interface PlanTransitionDecision {
  status: "trialing" | "active";
  autoRenew: boolean;
  trialEnd: string | null;
  trialStartedAt: string | null;
  clearTrialEnd: boolean;
  /** Same plan, still carrying, and auto-renew already matches the decision. */
  unchanged: boolean;
}

export class PlanTransitionError extends Error {
  constructor(public code: "trial_already_used" | "plan_has_no_trial") {
    super(code);
  }
}

export function addUtcDays(isoDate: string, days: number): string {
  const date = new Date(isoDate);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function carrying(status: SubscriptionLifeStatus): boolean {
  return status === "active" || status === "trialing" || status === "past_due";
}

/**
 * Decide the next subscription flags. Money is not moved here.
 */
export function decidePlanTransition(input: {
  source: PlanChangeSource;
  nowIso: string;
  trialDays: number;
  current: CurrentSubscriptionState | null;
  /** Admin may set this. A purchase always enables auto-renew. */
  autoRenew?: boolean;
  samePlan: boolean;
}): PlanTransitionDecision {
  const current = input.current;
  const stillCarrying = current != null && carrying(current.status);

  if (input.source === "purchase") {
    const autoRenew = true;
    if (input.samePlan && stillCarrying && current.autoRenew) {
      return {
        status: current.status === "trialing" ? "active" : "active",
        autoRenew,
        trialEnd: null,
        trialStartedAt: current.trialStartedAt,
        clearTrialEnd: true,
        unchanged: current.status !== "trialing",
      };
    }
    return {
      status: "active",
      autoRenew,
      trialEnd: null,
      trialStartedAt: current?.trialStartedAt ?? null,
      clearTrialEnd: true,
      unchanged: false,
    };
  }

  if (input.source === "trial") {
    if (current?.trialStartedAt) throw new PlanTransitionError("trial_already_used");
    if (input.trialDays <= 0) throw new PlanTransitionError("plan_has_no_trial");
    const trialEnd = addUtcDays(input.nowIso, input.trialDays);
    return {
      status: "trialing",
      autoRenew: input.autoRenew ?? true,
      trialEnd,
      trialStartedAt: input.nowIso,
      clearTrialEnd: false,
      unchanged: false,
    };
  }

  const autoRenew = input.autoRenew !== undefined ? input.autoRenew : (current?.autoRenew ?? false);
  const trialStillOpen =
    current?.status === "trialing" &&
    current.trialEnd != null &&
    current.trialEnd > input.nowIso;
  if (trialStillOpen && current) {
    return {
      status: "trialing",
      autoRenew,
      trialEnd: current.trialEnd,
      trialStartedAt: current.trialStartedAt,
      clearTrialEnd: false,
      unchanged: input.samePlan && current.autoRenew === autoRenew,
    };
  }
  // Re-assigning the plan a business already has, with the same auto-renew
  // flag, changes nothing. A different plan or an explicit auto-renew change
  // still writes.
  const unchanged =
    input.samePlan && stillCarrying && current?.status === "active" && current.autoRenew === autoRenew;
  return {
    status: "active",
    autoRenew,
    trialEnd: null,
    trialStartedAt: current?.trialStartedAt ?? null,
    clearTrialEnd: true,
    unchanged,
  };
}
