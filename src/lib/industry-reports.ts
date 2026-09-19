/**
 * Phase 21 Wave 7 — the pure half of the industry-specific reports: weight
 * reconciliation variance, warranty bucketing, and repair profitability.
 *
 * Everything here is arithmetic and classification over already-fetched
 * rows, kept out of the service layer so it can be unit-tested without a
 * database (the same split `aging.ts` uses for Phase 16's AR/AP aging
 * report).
 */
import Decimal from "decimal.js";

export interface WeightVariance {
  countedWeight: string;
  systemWeight: string;
  /** counted − system, in grams: positive is a surplus on the scale, negative a shortage. */
  variance: string;
  /** |variance| ÷ system, as a percent — null when the system believed there was nothing to count. */
  variancePercent: number | null;
}

/** The difference between what the scale said and what the books said, in grams. */
export function weightVariance(countedWeight: string, systemWeight: string): WeightVariance {
  const counted = new Decimal(countedWeight);
  const system = new Decimal(systemWeight);
  const variance = counted.minus(system);
  return {
    countedWeight: counted.toString(),
    systemWeight: system.toString(),
    variance: variance.toString(),
    variancePercent: system.isZero() ? null : Number(variance.abs().div(system).times(100).toFixed(3)),
  };
}

export type WarrantyState = "active" | "expiring" | "expired" | "none";

/**
 * Where a unit's warranty stands on `onDate`. `expiring` is `active` within
 * `expiringWithinDays` of the end — a shop wants the list of customers
 * whose cover is about to lapse, not just a yes/no.
 */
export function warrantyState(
  warranty: { startDate: string; endDate: string } | null,
  onDate: string,
  expiringWithinDays = 30,
): WarrantyState {
  if (!warranty) return "none";
  if (onDate < warranty.startDate) return "active"; // sold with cover that has not started counting yet
  if (onDate > warranty.endDate) return "expired";

  const end = Date.parse(`${warranty.endDate}T00:00:00Z`);
  const now = Date.parse(`${onDate}T00:00:00Z`);
  const daysLeft = Math.floor((end - now) / 86_400_000);
  return daysLeft <= expiringWithinDays ? "expiring" : "active";
}

export interface RepairProfitInput {
  /** What the customer was billed, excluding VAT (labor + parts charged). */
  net: number;
  /** What the consumed parts cost the shop. */
  partsCost: number;
}

export interface RepairProfit {
  revenue: number;
  partsCost: number;
  /** Revenue − parts cost. Negative on a warranty job, which is the honest answer: the shop spent parts and billed nobody. */
  margin: number;
}

export function repairProfit(tickets: RepairProfitInput[]): RepairProfit {
  const revenue = tickets.reduce((sum, t) => sum + t.net, 0);
  const partsCost = tickets.reduce((sum, t) => sum + t.partsCost, 0);
  return { revenue, partsCost, margin: revenue - partsCost };
}

export interface ConsignorBalanceInput {
  /** Credited to the consignor by sales of their goods (metal value + making charge). */
  owed: number;
  /** Already paid out to them. */
  paid: number;
}

/** What is still owed to a consignor: what their sold goods credited, less what has been paid out. */
export function consignorBalance(input: ConsignorBalanceInput): number {
  return input.owed - input.paid;
}

export type ExpiryBucket = "expired" | "under30" | "under90" | "ok";

export const EXPIRY_BUCKET_LABELS: Record<ExpiryBucket, string> = {
  expired: "منقضی",
  under30: "زیر ۳۰ روز",
  under90: "زیر ۹۰ روز",
  ok: "سالم",
};

/**
 * Phase 27 Wave 2 — which near-expiry bucket an expiry date falls in on
 * `today`: منقضی / زیر ۳۰ روز / زیر ۹۰ روز / سالم. The same bucketing shape
 * `warrantyState` uses, so the near-expiry home-page widget and the report
 * share one classifier. A null expiry is always `ok`.
 */
export function expiryBucket(
  expiryDate: string | null,
  today: string,
  thresholds: { under30?: number; under90?: number } = {},
): ExpiryBucket {
  if (!expiryDate) return "ok";
  const now = Date.parse(`${today}T00:00:00Z`);
  const expiry = Date.parse(`${expiryDate}T00:00:00Z`);
  const daysLeft = Math.floor((expiry - now) / 86_400_000);
  if (daysLeft < 0) return "expired";
  if (daysLeft <= (thresholds.under30 ?? 30)) return "under30";
  if (daysLeft <= (thresholds.under90 ?? 90)) return "under90";
  return "ok";
}

export type StockVelocityClass = "fast" | "slow" | "dead";

export const STOCK_VELOCITY_LABELS: Record<StockVelocityClass, string> = {
  fast: "پرفروش",
  slow: "کم‌فروش",
  dead: "راکد",
};

/**
 * Phase 27 Wave 11 — the named thresholds for fast/slow/dead-stock
 * classification. Kept as constants (not magic numbers in a query) so the
 * markdown planner, the report and the test all read the same numbers.
 */
export const STOCK_VELOCITY_THRESHOLDS = {
  /** Sold within this many days → fast regardless of total volume. */
  fastDays: 30,
  /** No sale for this many days (or never sold) → dead. */
  deadDays: 90,
  /** Units sold in the trailing window that rescue a slow-recent item back to fast. */
  fastMinUnits: 5,
} as const;

export interface StockVelocityInput {
  /** Units sold in the trailing window (e.g. the last 90 days). */
  unitsSold: number;
  /** Days since the last sale, or null when the item has never sold. */
  daysSinceLastSale: number | null;
}

/**
 * Fast / slow / dead over sales velocity and recency. A never-sold item is
 * dead (the shop bought it and it never moved); a recent sale is fast; in
 * between, enough units sold still counts as fast and the rest are slow.
 */
export function stockVelocityClass(input: StockVelocityInput): StockVelocityClass {
  if (input.daysSinceLastSale == null) return "dead";
  if (input.daysSinceLastSale >= STOCK_VELOCITY_THRESHOLDS.deadDays) return "dead";
  if (input.daysSinceLastSale <= STOCK_VELOCITY_THRESHOLDS.fastDays) return "fast";
  return input.unitsSold >= STOCK_VELOCITY_THRESHOLDS.fastMinUnits ? "fast" : "slow";
}

// ---------------------------------------------------------------------------
// Phase 27 Wave 13 — the per-trade report pack's pure half.

/** One signed loyalty-points ledger row (`customer_points.points`). */
export interface LoyaltyPointsRow {
  /** Signed: positive = earned, negative = redeemed. */
  points: number;
  /** The ledger's source_type, e.g. `sale` vs `loyalty_points_redemption`. */
  sourceType: string;
}

export interface LoyaltyRedemptionSummary {
  earnedPoints: number;
  /** Positive count of points redeemed (the absolute value of negative rows). */
  redeemedPoints: number;
  redemptionCount: number;
  netPoints: number;
}

/**
 * Collapse a points ledger into the four numbers the loyalty report shows:
 * what was earned, what was redeemed, how many redemption events there were,
 * and the net. Redemption value in Rial is derived by the caller from the
 * program's point_value_rial — it is not a property of the ledger itself.
 */
export function loyaltyRedemptionSummary(rows: LoyaltyPointsRow[]): LoyaltyRedemptionSummary {
  let earnedPoints = 0;
  let redeemedPoints = 0;
  let redemptionCount = 0;
  for (const row of rows) {
    if (row.points >= 0) {
      earnedPoints += row.points;
    } else {
      redeemedPoints += -row.points;
      // `redeem` was the source type before the loyalty posting gained a
      // descriptive source id. Keep historical rows in the event count while
      // all new redemptions use the explicit current spelling.
      if (row.sourceType === "loyalty_points_redemption" || row.sourceType === "redeem") redemptionCount += 1;
    }
  }
  return { earnedPoints, redeemedPoints, redemptionCount, netPoints: earnedPoints - redeemedPoints };
}

/** One application of a promotion to a sale — promotion id and the Rial it took off. */
export interface PromotionApplicationRow {
  promotionId: string;
  discountRial: number;
}

export interface PromotionEffectivenessRow {
  promotionId: string;
  applications: number;
  totalDiscountRial: number;
}

export interface PromotionEffectiveness {
  rows: PromotionEffectivenessRow[];
  totalApplications: number;
  totalDiscountRial: number;
}

/**
 * Sum per-promotion applications and discount so the promotions report can
 * rank campaigns by how often they fired and how much they cost. Order is the
 * input order; callers sort by whatever axis they are ranking on.
 */
export function promotionEffectiveness(rows: PromotionApplicationRow[]): PromotionEffectiveness {
  const byPromotion = new Map<string, PromotionEffectivenessRow>();
  let totalApplications = 0;
  let totalDiscountRial = 0;
  for (const row of rows) {
    const existing = byPromotion.get(row.promotionId) ?? {
      promotionId: row.promotionId,
      applications: 0,
      totalDiscountRial: 0,
    };
    existing.applications += 1;
    existing.totalDiscountRial += row.discountRial;
    totalApplications += 1;
    totalDiscountRial += row.discountRial;
    byPromotion.set(row.promotionId, existing);
  }
  return {
    rows: [...byPromotion.values()],
    totalApplications,
    totalDiscountRial,
  };
}

/** A layaway plan as the report reads it (already mapped from `layaway_plans`). */
export interface LayawayBookRow {
  planNumber: number;
  status: "open" | "completed" | "cancelled";
  totalValueRial: number;
  paidRial: number;
  grams: string;
}

export interface LayawayBook {
  openCount: number;
  openValueRial: number;
  openPaidRial: number;
  /** What open plans still owe: Σ(total − paid). */
  openOutstandingRial: number;
  completedCount: number;
  totalGrams: string;
}

/**
 * The layaway book: how many plans are open, the Rial still owed on them, and
 * the total grams on the books — the jeweller's receivables position at a
 * glance. Completed/cancelled plans contribute only to the count.
 */
export function layawayBook(rows: LayawayBookRow[]): LayawayBook {
  let openCount = 0;
  let openValueRial = 0;
  let openPaidRial = 0;
  let completedCount = 0;
  let grams = new Decimal(0);
  for (const row of rows) {
    grams = grams.plus(row.grams);
    if (row.status === "open") {
      openCount += 1;
      openValueRial += row.totalValueRial;
      openPaidRial += row.paidRial;
    } else if (row.status === "completed") {
      completedCount += 1;
    }
  }
  return {
    openCount,
    openValueRial,
    openPaidRial,
    openOutstandingRial: openValueRial - openPaidRial,
    completedCount,
    totalGrams: grams.toString(),
  };
}
