/**
 * Fixed-asset depreciation — pure math, no DB access (Phase 22 Wave 5,
 * second slice, issue #160 §2). DB orchestration (posting, tracking which
 * periods have already been depreciated) lives in fixed-assets-service.ts.
 *
 * Straight-line only for v1 — the simplest default, matching every other
 * phase's "start simple, revisit if asked" pattern; no declining-balance,
 * units-of-production, or disposal/sale-of-asset workflow yet.
 */

export interface DepreciableAsset {
  cost: number;
  salvageValue: number;
  usefulLifeMonths: number;
}

/** Persian validation errors for a new fixed asset; empty = valid. */
export function validateFixedAsset(input: {
  name: string;
  acquisitionDate: string;
  cost: number;
  salvageValue: number;
  usefulLifeMonths: number;
}): string[] {
  const errors: string[] = [];
  if (!input.name?.trim()) errors.push("نام دارایی الزامی است.");
  if (!input.acquisitionDate?.trim() || Number.isNaN(Date.parse(input.acquisitionDate))) {
    errors.push("تاریخ خرید معتبر نیست.");
  }
  if (!Number.isSafeInteger(input.cost) || input.cost <= 0) {
    errors.push("بهای تمام‌شده باید عدد صحیح مثبت باشد.");
  }
  if (!Number.isSafeInteger(input.salvageValue) || input.salvageValue < 0) {
    errors.push("ارزش اسقاط باید عدد صحیح نامنفی باشد.");
  }
  if (
    Number.isSafeInteger(input.cost) &&
    Number.isSafeInteger(input.salvageValue) &&
    input.salvageValue >= input.cost
  ) {
    errors.push("ارزش اسقاط باید کمتر از بهای تمام‌شده باشد.");
  }
  if (!Number.isInteger(input.usefulLifeMonths) || input.usefulLifeMonths <= 0) {
    errors.push("عمر مفید باید عدد صحیح مثبت (به ماه) باشد.");
  }
  return errors;
}

/** The depreciable base — the total amount ever depreciated over the asset's life. */
export function depreciableBase(asset: DepreciableAsset): number {
  return asset.cost - asset.salvageValue;
}

/** Straight-line: the depreciable base spread evenly over the useful life, rounded to whole Rial. */
export function monthlyDepreciation(asset: DepreciableAsset): number {
  return Math.round(depreciableBase(asset) / asset.usefulLifeMonths);
}

/**
 * How much a period should depreciate, given `accumulatedSoFar` already
 * posted and `periodsPostedSoFar` prior periods. The regular monthly amount
 * for every period except the last scheduled one (`periodsPostedSoFar + 1
 * >= usefulLifeMonths`), which instead absorbs whatever's left of the
 * depreciable base — rounding `monthlyDepreciation` to the nearest whole
 * Rial each period would otherwise leave a few Rial of the depreciable base
 * permanently unposted (e.g. 100,000 over 3 months rounds to 33,333/month,
 * three of which sum to only 99,999). `0` means already fully depreciated;
 * the caller rejects posting that.
 */
export function depreciationForPeriod(
  asset: DepreciableAsset,
  accumulatedSoFar: number,
  periodsPostedSoFar: number,
): number {
  const remaining = depreciableBase(asset) - accumulatedSoFar;
  if (remaining <= 0) return 0;
  const isFinalScheduledPeriod = periodsPostedSoFar + 1 >= asset.usefulLifeMonths;
  return isFinalScheduledPeriod ? remaining : Math.min(monthlyDepreciation(asset), remaining);
}
