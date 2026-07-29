/**
 * Phase 18 — framework-free credit calculations for the platform AI service.
 *
 * Money remains integer Rial; “credits” are only a display unit derived from
 * the platform-configured Rial value. Keeping the calculation here makes the
 * rounding and no-negative-balance policy explicit and independently tested.
 */

export interface AiTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AiUsageRates {
  inputTokenRialPerMillion: number;
  outputTokenRialPerMillion: number;
}

const TOKENS_PER_MILLION = 1_000_000;

function wholeNonNegative(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/**
 * Convert provider-reported tokens to an integer-Rial cost. The sum is rounded
 * once, so a request is never charged two minimum-Rial roundings merely because
 * it contains both prompt and completion tokens.
 */
export function calculateAiUsageCostRial(usage: AiTokenUsage, rates: AiUsageRates): number {
  const inputTokens = wholeNonNegative(usage.inputTokens);
  const outputTokens = wholeNonNegative(usage.outputTokens);
  const inputRate = wholeNonNegative(rates.inputTokenRialPerMillion);
  const outputRate = wholeNonNegative(rates.outputTokenRialPerMillion);

  const fractionalRial =
    (inputTokens * inputRate + outputTokens * outputRate) / TOKENS_PER_MILLION;
  return Number.isFinite(fractionalRial) ? Math.ceil(fractionalRial) : 0;
}

/**
 * Conservative fallback for OpenAI-compatible providers that omit usage data.
 * It intentionally over-estimates Persian/UTF-8 text instead of silently
 * making an otherwise billed request free.
 */
export function estimateTokens(text: string): number {
  const chars = Array.from(text.trim()).length;
  return chars === 0 ? 0 : Math.ceil(chars / 2);
}

/** The non-negative whole “credit” count shown in UI from a Rial balance. */
export function creditUnitsForRial(balanceRial: number, creditUnitRial: number): number {
  const balance = wholeNonNegative(balanceRial);
  const unit = wholeNonNegative(creditUnitRial);
  if (unit === 0) return 0;
  return Math.floor(balance / unit);
}
