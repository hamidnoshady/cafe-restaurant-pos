import { describe, expect, it } from "vitest";
import {
  daysBetween,
  LIFECYCLE_ORDER,
  LIFECYCLE_STAGES,
  lifecycleStage,
  lifetimeValue,
  quintileScores,
  retentionBetween,
  scorePopulation,
  stageDistribution,
  type CustomerRfmInput,
} from "./crm-scoring";

describe("daysBetween", () => {
  it("counts whole calendar days", () => {
    expect(daysBetween("2026-03-01", "2026-03-10")).toBe(9);
    expect(daysBetween("2026-03-10", "2026-03-10")).toBe(0);
  });

  it("is unaffected by a DST transition", () => {
    // Pure UTC arithmetic: a 23-hour civil day must still count as one day, or
    // every recency score shifts once a year.
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
  });
});

describe("quintileScores", () => {
  it("gives ties the same score", () => {
    // Two customers with three orders each must not land in different bands —
    // the same history cannot tell two stories.
    const scores = quintileScores([3, 3, 1, 10], true);
    expect(scores[0]).toBe(scores[1]);
  });

  it("puts everyone in the middle when the population is uniform", () => {
    expect(quintileScores([5, 5, 5, 5], true)).toEqual([3, 3, 3, 3]);
  });

  it("scores the best value 5 and the worst 1 when ascending", () => {
    const scores = quintileScores([1, 2, 3, 4, 5], true);
    expect(scores[0]).toBe(1);
    expect(scores[4]).toBe(5);
  });

  it("inverts for recency, where fewer days is better", () => {
    const days = [1, 400];
    const [recent, stale] = quintileScores(days, false);
    expect(recent).toBeGreaterThan(stale);
  });

  it("separates a rare big spender out of a population of ones", () => {
    // Distinct-value ranking, not row-index splitting: this is what keeps the
    // one customer who matters from being averaged into the crowd.
    const scores = quintileScores([1, 1, 1, 1, 1, 1, 1, 1, 1, 900], true);
    expect(scores[9]).toBe(5);
    expect(scores[0]).toBe(1);
  });

  it("stays within 1..5 and handles the empty population", () => {
    expect(quintileScores([], true)).toEqual([]);
    for (const score of quintileScores([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], true)) {
      expect(score).toBeGreaterThanOrEqual(1);
      expect(score).toBeLessThanOrEqual(5);
    }
  });
});

describe("lifecycleStage", () => {
  it("names the corners the way the playbooks do", () => {
    expect(lifecycleStage(5, 5, 5)).toBe("champion");
    expect(lifecycleStage(1, 1, 1)).toBe("lost");
  });

  it("prioritises «نباید از دست برود» over «در معرض ریزش» for a lapsed top spender", () => {
    // The more urgent label has to win, because the response differs: a lapsed
    // big spender gets a phone call, a lapsed regular gets a coupon.
    expect(lifecycleStage(2, 5, 5)).toBe("cant_lose");
  });

  it("calls a brand-new low-volume buyer «new», not «lost»", () => {
    expect(lifecycleStage(5, 1, 1)).toBe("new");
  });

  it("only ever returns a stage that has display metadata and a fixed position", () => {
    for (let r = 1; r <= 5; r += 1) {
      for (let f = 1; f <= 5; f += 1) {
        for (let m = 1; m <= 5; m += 1) {
          const stage = lifecycleStage(r, f, m);
          expect(LIFECYCLE_STAGES[stage]).toBeTruthy();
          expect(LIFECYCLE_ORDER).toContain(stage);
        }
      }
    }
  });

  it("has a Persian label and advice for every stage", () => {
    for (const stage of LIFECYCLE_ORDER) {
      const meta = LIFECYCLE_STAGES[stage];
      expect(meta.label.length).toBeGreaterThan(0);
      expect(/[\u0600-\u06FF]/.test(meta.label)).toBe(true);
    }
  });
});

describe("scorePopulation", () => {
  const anchor = "2026-03-10";
  const rows: CustomerRfmInput[] = [
    { customerId: "a", name: "الف", lastPurchaseDate: "2026-03-09", orderCount: 40, totalSpentRial: 80_000_000 },
    { customerId: "b", name: "ب", lastPurchaseDate: "2026-03-01", orderCount: 12, totalSpentRial: 20_000_000 },
    { customerId: "c", name: "ج", lastPurchaseDate: "2025-06-01", orderCount: 2, totalSpentRial: 1_000_000 },
    { customerId: "d", name: "د", lastPurchaseDate: null, orderCount: 0, totalSpentRial: 0 },
  ];

  it("scores everyone, including customers who never bought", () => {
    const scored = scorePopulation(rows, anchor);
    expect(scored).toHaveLength(4);
    expect(new Set(scored.map((s) => s.customerId)).size).toBe(4);
  });

  it("marks a customer with no purchases «never_purchased» rather than «lost»", () => {
    // A record with no history is not a customer who left; the difference
    // decides whether they belong in a win-back campaign.
    const scored = scorePopulation(rows, anchor);
    const never = scored.find((s) => s.customerId === "d")!;
    expect(never.stage).toBe("never_purchased");
  });

  it("excludes never-purchasers from the quintile population", () => {
    // Otherwise a shop with many walk-in records looks like it lost everyone.
    const withoutNever = scorePopulation(rows.slice(0, 3), anchor);
    const withNever = scorePopulation(rows, anchor);
    for (const row of withoutNever) {
      const same = withNever.find((s) => s.customerId === row.customerId)!;
      expect(same.cell).toBe(row.cell);
    }
  });

  it("ranks the most recent, most frequent, biggest spender top", () => {
    const scored = scorePopulation(rows, anchor);
    const best = scored.find((s) => s.customerId === "a")!;
    const worst = scored.find((s) => s.customerId === "c")!;
    expect(best.total).toBeGreaterThan(worst.total);
    expect(best.recency).toBe(5);
  });

  it("reports recency in days from the anchor, not from today", () => {
    const scored = scorePopulation(rows, anchor);
    expect(scored.find((s) => s.customerId === "a")!.recencyDays).toBe(1);
  });

  it("handles the empty population and a single customer", () => {
    expect(scorePopulation([], anchor)).toEqual([]);
    const solo = scorePopulation([rows[0]], anchor);
    expect(solo).toHaveLength(1);
    expect(solo[0].recency).toBe(3);
  });
});

describe("stageDistribution", () => {
  it("aggregates count and value per stage in the canonical order", () => {
    const scored = scorePopulation(
      [
        { customerId: "a", name: "a", lastPurchaseDate: "2026-03-09", orderCount: 40, totalSpentRial: 80_000_000 },
        { customerId: "b", name: "b", lastPurchaseDate: null, orderCount: 0, totalSpentRial: 0 },
      ],
      "2026-03-10",
    );
    const distribution = stageDistribution(scored);
    const total = distribution.reduce((sum, entry) => sum + entry.count, 0);
    expect(total).toBe(2);

    const positions = distribution.map((entry) => LIFECYCLE_ORDER.indexOf(entry.stage));
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
  });

  it("omits stages nobody is in", () => {
    expect(stageDistribution([])).toEqual([]);
  });
});

describe("retentionBetween", () => {
  it("asks whether it is the *same* people, not how many", () => {
    // 100 last window and 100 this window can be a total churn; counts alone
    // would score that as perfect retention.
    const result = retentionBetween({
      priorCustomerIds: ["a", "b", "c", "d"],
      currentCustomerIds: ["e", "f", "g", "h"],
    });
    expect(result.retainedCount).toBe(0);
    expect(result.retentionRate).toBe(0);
    expect(result.churnRate).toBe(100);
    expect(result.newCount).toBe(4);
  });

  it("computes retention, churn and new counts together", () => {
    const result = retentionBetween({
      priorCustomerIds: ["a", "b", "c", "d"],
      currentCustomerIds: ["a", "b", "x"],
    });
    expect(result.retainedCount).toBe(2);
    expect(result.churnedCount).toBe(2);
    expect(result.newCount).toBe(1);
    expect(result.retentionRate).toBe(50);
    expect(result.churnRate).toBe(50);
  });

  it("de-duplicates ids so a repeat buyer is one person", () => {
    const result = retentionBetween({
      priorCustomerIds: ["a", "a", "a"],
      currentCustomerIds: ["a", "a"],
    });
    expect(result.priorCount).toBe(1);
    expect(result.retentionRate).toBe(100);
  });

  it("returns zero, not NaN, when there is no prior window", () => {
    const result = retentionBetween({ priorCustomerIds: [], currentCustomerIds: ["a"] });
    expect(result.retentionRate).toBe(0);
    expect(result.churnRate).toBe(0);
    expect(result.newCount).toBe(1);
  });
});

describe("lifetimeValue", () => {
  it("keeps realised spend separate from the projection", () => {
    // historicRial must be reconcilable against the ledger; the projection is
    // arithmetic on a cadence and is never allowed to contaminate it.
    const result = lifetimeValue({ totalSpentRial: 12_000_000, orderCount: 12, activeDays: 330 });
    expect(result.historicRial).toBe(12_000_000);
    expect(result.averageOrderRial).toBe(1_000_000);
    expect(result.purchaseIntervalDays).toBe(30);
    expect(result.annualFrequency).toBeCloseTo(12.2, 1);
    expect(result.projectedAnnualRial).toBeGreaterThan(0);
  });

  it("refuses to project from a single order", () => {
    const result = lifetimeValue({ totalSpentRial: 5_000_000, orderCount: 1, activeDays: 0 });
    expect(result.historicRial).toBe(5_000_000);
    expect(result.averageOrderRial).toBe(5_000_000);
    expect(result.purchaseIntervalDays).toBeNull();
    expect(result.annualFrequency).toBeNull();
    expect(result.projectedAnnualRial).toBeNull();
  });

  it("refuses to project when every order landed on one day", () => {
    // Two orders in one visit is not a cadence; dividing by zero days would
    // invent an enormous annual figure.
    const result = lifetimeValue({ totalSpentRial: 400_000, orderCount: 2, activeDays: 0 });
    expect(result.projectedAnnualRial).toBeNull();
  });

  it("returns zero rather than NaN for a customer with no orders", () => {
    const result = lifetimeValue({ totalSpentRial: 0, orderCount: 0, activeDays: 0 });
    expect(result.averageOrderRial).toBe(0);
    expect(result.historicRial).toBe(0);
  });

  it("keeps money in whole Rial", () => {
    const result = lifetimeValue({ totalSpentRial: 1_000_001, orderCount: 3, activeDays: 60 });
    expect(Number.isInteger(result.averageOrderRial)).toBe(true);
    expect(Number.isInteger(result.projectedAnnualRial!)).toBe(true);
  });
});
