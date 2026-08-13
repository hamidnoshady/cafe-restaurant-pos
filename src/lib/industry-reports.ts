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
