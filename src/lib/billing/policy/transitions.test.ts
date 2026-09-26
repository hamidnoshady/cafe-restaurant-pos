import { describe, expect, it } from "vitest";
import { decidePlanTransition, PlanTransitionError } from "./transitions";

const now = "2026-09-01T00:00:00.000Z";

describe("decidePlanTransition", () => {
  it("enables auto-renew on a new purchase", () => {
    const decision = decidePlanTransition({
      source: "purchase",
      nowIso: now,
      trialDays: 7,
      current: null,
      samePlan: false,
    });
    expect(decision.autoRenew).toBe(true);
    expect(decision.status).toBe("active");
    expect(decision.unchanged).toBe(false);
  });

  it("enables auto-renew on an upgrade even when the current flag is false", () => {
    const decision = decidePlanTransition({
      source: "purchase",
      nowIso: now,
      trialDays: 0,
      current: {
        status: "active",
        autoRenew: false,
        trialStartedAt: null,
        trialEnd: null,
        planKey: "starter",
      },
      samePlan: false,
    });
    expect(decision.autoRenew).toBe(true);
    expect(decision.unchanged).toBe(false);
  });

  it("converts a trial purchase of the same plan to active with auto-renew", () => {
    const decision = decidePlanTransition({
      source: "purchase",
      nowIso: now,
      trialDays: 7,
      current: {
        status: "trialing",
        autoRenew: false,
        trialStartedAt: "2026-08-01T00:00:00.000Z",
        trialEnd: "2026-08-08T00:00:00.000Z",
        planKey: "pro",
      },
      samePlan: true,
    });
    expect(decision.status).toBe("active");
    expect(decision.autoRenew).toBe(true);
    expect(decision.clearTrialEnd).toBe(true);
    expect(decision.unchanged).toBe(false);
  });

  it("leaves a repeat purchase of an already auto-renewing plan unchanged", () => {
    const decision = decidePlanTransition({
      source: "purchase",
      nowIso: now,
      trialDays: 0,
      current: {
        status: "active",
        autoRenew: true,
        trialStartedAt: null,
        trialEnd: null,
        planKey: "pro",
      },
      samePlan: true,
    });
    expect(decision.unchanged).toBe(true);
  });

  it("starts a trial once and refuses a second one", () => {
    const first = decidePlanTransition({
      source: "trial",
      nowIso: now,
      trialDays: 7,
      current: null,
      samePlan: false,
    });
    expect(first.status).toBe("trialing");
    expect(first.trialEnd).toBe("2026-09-08T00:00:00.000Z");
    expect(() =>
      decidePlanTransition({
        source: "trial",
        nowIso: now,
        trialDays: 7,
        current: {
          status: "active",
          autoRenew: true,
          trialStartedAt: first.trialStartedAt,
          trialEnd: null,
          planKey: "pro",
        },
        samePlan: true,
      }),
    ).toThrow(PlanTransitionError);
  });

  it("keeps an open trial when an admin changes plan", () => {
    const decision = decidePlanTransition({
      source: "admin",
      nowIso: now,
      trialDays: 0,
      current: {
        status: "trialing",
        autoRenew: true,
        trialStartedAt: "2026-08-20T00:00:00.000Z",
        trialEnd: "2026-09-10T00:00:00.000Z",
        planKey: "starter",
      },
      samePlan: false,
    });
    expect(decision.status).toBe("trialing");
    expect(decision.trialEnd).toBe("2026-09-10T00:00:00.000Z");
  });

  it("preserves auto-renew on a manual assignment unless the caller sets it", () => {
    const kept = decidePlanTransition({
      source: "admin",
      nowIso: now,
      trialDays: 0,
      current: {
        status: "active",
        autoRenew: true,
        trialStartedAt: null,
        trialEnd: null,
        planKey: "pro",
      },
      samePlan: false,
    });
    expect(kept.autoRenew).toBe(true);
    const explicit = decidePlanTransition({
      source: "admin",
      nowIso: now,
      trialDays: 0,
      current: {
        status: "active",
        autoRenew: true,
        trialStartedAt: null,
        trialEnd: null,
        planKey: "pro",
      },
      autoRenew: false,
      samePlan: false,
    });
    expect(explicit.autoRenew).toBe(false);
  });
});
