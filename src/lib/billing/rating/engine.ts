/**
 * The one customer-price calculation. Callers pass a quantity, the allowance
 * still remaining, and the price version that was effective when the usage
 * happened. They do not invent a rate.
 */

export interface PriceVersionPoint {
  id?: string;
  version: number;
  effectiveFrom: string;
  effectiveUntil: string | null;
  unitAmountRial: number;
  unitSize: number;
}

export interface RateInput {
  quantity: number;
  /** Allowance still unused. Null means the meter has no included quantity. */
  includedRemaining: number | null;
  overageEnabled: boolean;
  /** Absolute quantity cap for the period, including the allowance. Null = no cap. */
  hardLimit: number | null;
  /** Null when no price version covers the usage instant — never treated as free. */
  price: { unitAmountRial: number; unitSize: number } | null;
  rounding: "ceil" | "floor";
}

export interface RateResult {
  includedConsumed: number;
  overageQuantity: number;
  amountRial: number;
  blocked: boolean;
  blockReason: "hard_limit" | "overage_disabled" | "no_price" | null;
}

export function selectPriceVersion<T extends PriceVersionPoint>(versions: readonly T[], atIso: string): T | null {
  const at = new Date(atIso).getTime();
  if (Number.isNaN(at)) return null;
  const eligible = versions.filter((version) => {
    const from = new Date(version.effectiveFrom).getTime();
    const until = version.effectiveUntil ? new Date(version.effectiveUntil).getTime() : Number.POSITIVE_INFINITY;
    return from <= at && at < until;
  });
  eligible.sort((a, b) => b.version - a.version || b.effectiveFrom.localeCompare(a.effectiveFrom));
  return eligible[0] ?? null;
}

function money(raw: number, rounding: "ceil" | "floor"): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return rounding === "ceil" ? Math.ceil(raw) : Math.floor(raw);
}

/**
 * Rate one integer quantity. Included units are free. Overage is priced from
 * the selected version. A missing price blocks the charge instead of billing zero.
 */
export function rateQuantity(input: RateInput): RateResult {
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 0) {
    throw new Error("invalid_quantity");
  }
  const includedRemaining = input.includedRemaining == null ? 0 : Math.max(0, Math.floor(input.includedRemaining));
  if (input.hardLimit != null && input.quantity > input.hardLimit) {
    return {
      includedConsumed: 0,
      overageQuantity: 0,
      amountRial: 0,
      blocked: true,
      blockReason: "hard_limit",
    };
  }
  const includedConsumed = Math.min(input.quantity, includedRemaining);
  const overageQuantity = input.quantity - includedConsumed;
  if (overageQuantity === 0) {
    return { includedConsumed, overageQuantity: 0, amountRial: 0, blocked: false, blockReason: null };
  }
  if (!input.overageEnabled) {
    return { includedConsumed, overageQuantity, amountRial: 0, blocked: true, blockReason: "overage_disabled" };
  }
  if (!input.price) {
    return { includedConsumed, overageQuantity, amountRial: 0, blocked: true, blockReason: "no_price" };
  }
  const unitSize = Math.max(1, Math.floor(input.price.unitSize));
  const amountRial = money((overageQuantity / unitSize) * Math.max(0, Math.floor(input.price.unitAmountRial)), input.rounding);
  return { includedConsumed, overageQuantity, amountRial, blocked: false, blockReason: null };
}

export interface StorageDayTariff {
  billingEnabled: boolean;
  dailyFlatRial: number;
  dailyPerGbRial: number;
  freeQuotaMb: number;
}

export interface StorageDayRate {
  flatRial: number;
  perGbRial: number;
  totalRial: number;
  billableBytes: number;
  /** bytes × 24 — the auditable quantity for `media.storage_byte_hour`. */
  byteHours: number;
}

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

/**
 * One local day's storage, priced from the tariff that was effective that day.
 * The flat component is a fixed daily fee; bytes above the quota are pro-rated
 * per GiB and rounded up. The byte-hour quantity is what the usage ledger stores.
 */
export function rateStorageDay(storedBytes: number, tariff: StorageDayTariff): StorageDayRate {
  const bytes = Math.max(0, Math.floor(storedBytes));
  const byteHours = bytes * 24;
  if (!tariff.billingEnabled || bytes === 0) {
    return { flatRial: 0, perGbRial: 0, totalRial: 0, billableBytes: 0, byteHours };
  }
  const flatRial = Math.max(0, Math.floor(tariff.dailyFlatRial));
  const billableBytes = Math.max(0, bytes - Math.max(0, Math.floor(tariff.freeQuotaMb)) * MB);
  const perGbRial =
    billableBytes > 0 && tariff.dailyPerGbRial > 0
      ? Math.ceil((billableBytes / GB) * tariff.dailyPerGbRial)
      : 0;
  return { flatRial, perGbRial, totalRial: flatRial + perGbRial, billableBytes, byteHours };
}
