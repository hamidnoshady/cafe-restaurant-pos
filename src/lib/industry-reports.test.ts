import { describe, expect, it } from "vitest";
import {
  consignorBalance,
  expiryBucket,
  layawayBook,
  loyaltyRedemptionSummary,
  promotionEffectiveness,
  repairProfit,
  stockVelocityClass,
  warrantyState,
  weightVariance,
} from "./industry-reports";

describe("weightVariance", () => {
  it("is counted − system, with a percentage of the system figure", () => {
    expect(weightVariance("99.5", "100")).toEqual({
      countedWeight: "99.5",
      systemWeight: "100",
      variance: "-0.5",
      variancePercent: 0.5,
    });
  });

  it("reports a surplus as a positive variance", () => {
    expect(weightVariance("101.25", "100").variance).toBe("1.25");
  });

  it("is exact at three decimal places of a gram — no floating-point drift", () => {
    expect(weightVariance("12.345", "12.344").variance).toBe("0.001");
  });

  it("has no percentage when the system believed there was nothing to count", () => {
    expect(weightVariance("3", "0").variancePercent).toBeNull();
  });
});

describe("warrantyState", () => {
  const warranty = { startDate: "2026-01-01", endDate: "2027-01-01" };

  it("is none for a unit with no warranty at all", () => {
    expect(warrantyState(null, "2026-06-01")).toBe("none");
  });

  it("is active well inside the window and expired past its end", () => {
    expect(warrantyState(warranty, "2026-06-01")).toBe("active");
    expect(warrantyState(warranty, "2027-01-02")).toBe("expired");
  });

  it("is expiring within the notice window, and on the last day itself", () => {
    expect(warrantyState(warranty, "2026-12-15")).toBe("expiring");
    expect(warrantyState(warranty, "2027-01-01")).toBe("expiring");
  });

  it("takes the notice window as a parameter", () => {
    expect(warrantyState(warranty, "2026-11-15", 30)).toBe("active");
    expect(warrantyState(warranty, "2026-11-15", 90)).toBe("expiring");
  });
});

describe("repairProfit", () => {
  it("totals revenue and parts cost across tickets", () => {
    expect(repairProfit([
      { net: 2_800_000, partsCost: 300_000 },
      { net: 1_000_000, partsCost: 100_000 },
    ])).toEqual({ revenue: 3_800_000, partsCost: 400_000, margin: 3_400_000 });
  });

  it("reports a negative margin for a warranty job rather than hiding it", () => {
    expect(repairProfit([{ net: 0, partsCost: 1_500_000 }]).margin).toBe(-1_500_000);
  });

  it("is all zeroes for no tickets", () => {
    expect(repairProfit([])).toEqual({ revenue: 0, partsCost: 0, margin: 0 });
  });
});

describe("expiryBucket", () => {
  const TODAY = "2026-08-16";

  it("is expired once the date has passed, and ok for a null expiry", () => {
    expect(expiryBucket("2026-08-15", TODAY)).toBe("expired");
    expect(expiryBucket(null, TODAY)).toBe("ok");
  });

  it("is sellable but flagged inside the notice windows", () => {
    expect(expiryBucket("2026-08-16", TODAY)).toBe("under30"); // last day, daysLeft 0
    expect(expiryBucket("2026-09-10", TODAY)).toBe("under30");
    expect(expiryBucket("2026-09-16", TODAY)).toBe("under90"); // exactly 31 days
    expect(expiryBucket("2026-10-01", TODAY)).toBe("under90");
    expect(expiryBucket("2026-12-01", TODAY)).toBe("ok");
  });

  it("takes the thresholds as parameters", () => {
    expect(expiryBucket("2026-09-10", TODAY, { under30: 10 })).toBe("under90");
  });
});

describe("consignorBalance", () => {
  it("is what their sold goods credited, less what has been paid out", () => {
    expect(consignorBalance({ owed: 50_000_000, paid: 20_000_000 })).toBe(30_000_000);
    expect(consignorBalance({ owed: 50_000_000, paid: 50_000_000 })).toBe(0);
  });
});

describe("stockVelocityClass", () => {
  it("is fast for a recent sale", () => {
    expect(stockVelocityClass({ unitsSold: 2, daysSinceLastSale: 5 })).toBe("fast");
    expect(stockVelocityClass({ unitsSold: 0, daysSinceLastSale: 30 })).toBe("fast");
  });

  it("is dead once nothing has sold for 90 days, or when it has never sold", () => {
    expect(stockVelocityClass({ unitsSold: 0, daysSinceLastSale: 90 })).toBe("dead");
    expect(stockVelocityClass({ unitsSold: 0, daysSinceLastSale: null })).toBe("dead");
  });

  it("is slow between the windows, but a healthy volume rescues it to fast", () => {
    expect(stockVelocityClass({ unitsSold: 1, daysSinceLastSale: 45 })).toBe("slow");
    expect(stockVelocityClass({ unitsSold: 5, daysSinceLastSale: 45 })).toBe("fast");
  });
});

describe("loyaltyRedemptionSummary", () => {
  it("nets earned against redeemed and counts redemptions separately", () => {
    expect(
      loyaltyRedemptionSummary([
        { points: 100, sourceType: "sale" },
        { points: 40, sourceType: "sale" },
        { points: -30, sourceType: "loyalty_points_redemption" },
        { points: -10, sourceType: "loyalty_points_redemption" },
      ]),
    ).toEqual({ earnedPoints: 140, redeemedPoints: 40, redemptionCount: 2, netPoints: 100 });
  });

  it("does not double-count a negative adjustment as a redemption event", () => {
    const summary = loyaltyRedemptionSummary([{ points: -5, sourceType: "manual_adjustment" }]);
    expect(summary.redeemedPoints).toBe(5);
    expect(summary.redemptionCount).toBe(0);
  });

  it("is all zeroes for an empty ledger", () => {
    expect(loyaltyRedemptionSummary([])).toEqual({
      earnedPoints: 0,
      redeemedPoints: 0,
      redemptionCount: 0,
      netPoints: 0,
    });
  });
});

describe("promotionEffectiveness", () => {
  it("sums applications and discount per promotion", () => {
    const result = promotionEffectiveness([
      { promotionId: "a", discountRial: 50_000 },
      { promotionId: "b", discountRial: 10_000 },
      { promotionId: "a", discountRial: 30_000 },
    ]);
    expect(result.totalApplications).toBe(3);
    expect(result.totalDiscountRial).toBe(90_000);
    const a = result.rows.find((r) => r.promotionId === "a");
    expect(a).toEqual({ promotionId: "a", applications: 2, totalDiscountRial: 80_000 });
  });

  it("is empty for no applications", () => {
    expect(promotionEffectiveness([])).toEqual({ rows: [], totalApplications: 0, totalDiscountRial: 0 });
  });
});

describe("layawayBook", () => {
  it("totals open plans, outstanding Rial and grams across all plans", () => {
    const book = layawayBook([
      { planNumber: 1, status: "open", totalValueRial: 100_000_000, paidRial: 40_000_000, grams: "10.5" },
      { planNumber: 2, status: "open", totalValueRial: 50_000_000, paidRial: 50_000_000, grams: "5" },
      { planNumber: 3, status: "completed", totalValueRial: 20_000_000, paidRial: 20_000_000, grams: "2" },
      { planNumber: 4, status: "cancelled", totalValueRial: 30_000_000, paidRial: 0, grams: "3" },
    ]);
    expect(book.openCount).toBe(2);
    expect(book.openValueRial).toBe(150_000_000);
    expect(book.openPaidRial).toBe(90_000_000);
    expect(book.openOutstandingRial).toBe(60_000_000);
    expect(book.completedCount).toBe(1);
    expect(book.totalGrams).toBe("20.5");
  });
});
