import { describe, expect, it } from "vitest";
import { estimateAiTurn } from "./ai-estimate";

const rates = {
  inputTokenRialPerMillion: 50_000,
  outputTokenRialPerMillion: 100_000,
};

describe("Phase 18b Wave 5 turn-cost preview", () => {
  it("models a dashboard tool turn but never exceeds the existing maximum hold", () => {
    const estimate = estimateAiTurn({
      mode: "dashboard",
      promptContext: { mode: "dashboard", role: "manager", businessName: "کافه آزمون" },
      messages: [{ role: "user", content: "فروش هفته را با هفته قبل مقایسه کن" }],
      maxOutputTokens: 1_000,
      maxTurnRial: 75_000,
      rates,
    });

    expect(estimate.hasTools).toBe(true);
    expect(estimate.assumedToolRounds).toBe(2);
    expect(estimate.estimatedInputTokens).toBeGreaterThan(0);
    expect(estimate.estimatedOutputTokens).toBe(650);
    expect(estimate.estimatedCostRial).toBeLessThanOrEqual(75_000);
    expect(estimate.maximumReservationRial).toBe(75_000);
  });

  it("still models tool rounds with allowActions: false — only propose_action itself drops out", () => {
    const withActions = estimateAiTurn({
      mode: "dashboard",
      promptContext: { mode: "dashboard", role: "manager" },
      messages: [{ role: "user", content: "موجودی کم را نشان بده" }],
      maxOutputTokens: 1_000,
      maxTurnRial: 75_000,
      rates,
    });
    const withoutActions = estimateAiTurn({
      mode: "dashboard",
      promptContext: { mode: "dashboard", role: "manager" },
      messages: [{ role: "user", content: "موجودی کم را نشان بده" }],
      maxOutputTokens: 1_000,
      maxTurnRial: 75_000,
      rates,
      allowActions: false,
    });

    expect(withoutActions.hasTools).toBe(true);
    expect(withoutActions.estimatedInputTokens).toBeLessThan(withActions.estimatedInputTokens);
  });

  it("uses a single provider call for a no-tool proactive-style context", () => {
    const estimate = estimateAiTurn({
      mode: "proactive",
      promptContext: { mode: "proactive", businessName: "کافه آزمون" },
      messages: [{ role: "user", content: "داده‌های زمان‌بندی‌شده: {}" }],
      maxOutputTokens: 800,
      maxTurnRial: 50_000,
      rates,
    });

    expect(estimate.hasTools).toBe(false);
    expect(estimate.assumedToolRounds).toBe(1);
    expect(estimate.estimatedOutputTokens).toBe(400);
  });
});
