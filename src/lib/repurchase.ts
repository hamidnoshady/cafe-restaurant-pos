/**
 * Phase 27 Wave 5 — repeat-purchase prediction (pure, framework-free).
 *
 * Per customer × product, predict the next purchase date from that customer's
 * own order history: the median interval between consecutive purchases, with
 * a confidence floor so one purchase — or an erratic cadence — predicts
 * nothing. No ML, no external service, no database: the service layer fetches
 * the dates and this file does the arithmetic (the same split `aging.ts` and
 * `industry-reports.ts` use).
 */

export interface PurchaseHistoryInput {
  /** ISO dates (YYYY-MM-DD, Gregorian — the stored convention) of purchases of one product by one customer. */
  dates: string[];
}

export interface RepurchasePrediction {
  /** Predicted next purchase date (ISO), or null when the history is too thin or too erratic to act on. */
  nextPurchaseDate: string | null;
  /** Median interval between consecutive purchases, in whole days. */
  avgIntervalDays: number;
  purchaseCount: number;
  /** 0..1 — how stable the cadence is; 1 means perfectly regular. */
  confidence: number;
  /** True only when the prediction is strong enough to show on the «آماده خرید مجدد» list. */
  reliable: boolean;
}

const DAY_MS = 86_400_000;

function parseDay(iso: string): number {
  return Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
}

function toIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((parseDay(b) - parseDay(a)) / DAY_MS);
}

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Predict the next purchase date.
 *
 * The confidence is `1 − (range ÷ longest gap)`, clamped to 0..1: a perfectly
 * regular cadence (every gap equal) scores 1; an erratic one has a wide
 * spread relative to its longest gap and scores low, so it is suppressed
 * rather than shown as a real prediction. A single purchase has no interval
 * at all, so it predicts nothing by construction.
 */
export function predictNextPurchase(
  input: PurchaseHistoryInput,
  opts: { confidenceFloor?: number } = {},
): RepurchasePrediction {
  const { confidenceFloor = 0.5 } = opts;

  const sorted = [...new Set(input.dates.map((d) => d.slice(0, 10)))].sort();
  const intervals: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const gap = daysBetween(sorted[i - 1], sorted[i]);
    if (gap > 0) intervals.push(gap);
  }

  if (intervals.length === 0) {
    return { nextPurchaseDate: null, avgIntervalDays: 0, purchaseCount: sorted.length, confidence: 0, reliable: false };
  }

  const center = median(intervals);
  const shortest = Math.min(...intervals);
  const longest = Math.max(...intervals);
  const confidence =
    longest === 0 ? 0 : Math.max(0, Math.min(1, 1 - (longest - shortest) / longest));
  const reliable = confidence >= confidenceFloor;

  return {
    nextPurchaseDate: reliable ? toIso(parseDay(sorted[sorted.length - 1]) + center * DAY_MS) : null,
    avgIntervalDays: center,
    purchaseCount: sorted.length,
    confidence: Number(confidence.toFixed(3)),
    reliable,
  };
}
