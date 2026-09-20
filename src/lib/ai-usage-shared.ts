/**
 * Phase I (UI redesign) — the pure core of the AI *Usage* section.
 *
 * A read-only lens over `ai_wallet_settlements` (migration 0153): every AI turn
 * the wallet was charged for is one settlement row, tagged with where it came
 * from (`request_type`), the model, token counts, whether it hit the cache, and
 * the real vs charged Rial. The Usage section turns those rows into "what did AI
 * cost us, and where did it go" — the platform-owned truth the north-star IA
 * calls for, over the same billing the wallet already records.
 *
 * Framework-free (no `next`, no `db`, no JSX) so the service, the API route, the
 * client section and the unit tests all read one source of truth: the settled
 * `request_type` values and their Persian labels can never drift between the
 * chart and the row that produced it.
 */

/**
 * The origins a settlement can be tagged with — kept in lockstep with the
 * `request_type` CHECK on `ai_wallet_settlements`. A row whose type isn't one
 * of these (a future origin added to the DB before this list) is bucketed as
 * `other` by {@link normalizeRequestType} rather than dropped.
 */
export const AI_USAGE_REQUEST_TYPES = [
  "chat",
  "vision",
  "ocr",
  "media_detect",
  "proactive",
  "autopilot",
  "coworker",
  "agent",
  "automation",
  "embedding",
  "other",
] as const;

export type AiUsageRequestType = (typeof AI_USAGE_REQUEST_TYPES)[number];

const REQUEST_TYPE_SET = new Set<string>(AI_USAGE_REQUEST_TYPES);

/** The Persian label each origin reads as in the section. */
export const AI_USAGE_REQUEST_TYPE_LABELS: Record<AiUsageRequestType, string> = {
  chat: "گفت‌وگو",
  vision: "تحلیل تصویر",
  ocr: "خواندن سند",
  media_detect: "تشخیص رسانه",
  proactive: "پیشنهاد خودکار",
  autopilot: "خلبان خودکار",
  coworker: "همکار هوشمند",
  agent: "ایجنت سفارشی",
  automation: "اتوماسیون",
  embedding: "نمایه‌سازی",
  other: "سایر",
};

/**
 * Map a raw settled `request_type` to a known bucket. An unrecognised value
 * (or null) falls back to `other`, so a settlement is always counted somewhere
 * and the section can never crash on a type it hasn't heard of.
 */
export function normalizeRequestType(raw: string | null | undefined): AiUsageRequestType {
  return raw && REQUEST_TYPE_SET.has(raw) ? (raw as AiUsageRequestType) : "other";
}

/** The Persian label for a raw or known origin. */
export function requestTypeLabel(raw: string | null | undefined): string {
  return AI_USAGE_REQUEST_TYPE_LABELS[normalizeRequestType(raw)];
}

/** How pricing was decided for a settlement — the same three the DB records. */
export type AiUsagePricedBy = "gateway" | "token_rate" | "free";

/** One row in the recent-turns list the section renders. */
export interface AiUsageTurn {
  id: string;
  requestType: AiUsageRequestType;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheHit: boolean;
  chargedRial: number;
  providerCostRial: number;
  pricedBy: AiUsagePricedBy;
  createdAt: string;
}

/** A per-origin spend slice for the breakdown chart. */
export interface AiUsageByType {
  requestType: AiUsageRequestType;
  label: string;
  turns: number;
  chargedRial: number;
}

/** The whole Usage payload the API returns and the section renders. */
export interface AiUsageSummary {
  /** The window this summary covers, in whole days back from now. */
  windowDays: number;
  balanceRial: number;
  debtRial: number;
  /** Totals across the window. */
  totalTurns: number;
  totalChargedRial: number;
  totalProviderCostRial: number;
  cacheHits: number;
  /** Spend broken down by origin, richest first. */
  byType: AiUsageByType[];
  /** The most recent turns (capped), newest first. */
  recentTurns: AiUsageTurn[];
}

/** The windows the section offers, in days. The first is the default. */
export const AI_USAGE_WINDOWS = [7, 30, 90] as const;
export type AiUsageWindowDays = (typeof AI_USAGE_WINDOWS)[number];

/**
 * Clamp an arbitrary `days` request to one of the offered windows, defaulting
 * to the first. Keeps the API from running an unbounded scan on a hand-typed
 * query string.
 */
export function normalizeWindowDays(raw: unknown): AiUsageWindowDays {
  const value = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  return (AI_USAGE_WINDOWS as readonly number[]).includes(value)
    ? (value as AiUsageWindowDays)
    : AI_USAGE_WINDOWS[0];
}

/**
 * The share of the cache hits over the total turns, 0..1. Guards the zero-turn
 * case so the section shows «۰٪» rather than NaN before any AI has been used.
 */
export function cacheHitRate(summary: {
  cacheHits: number;
  totalTurns: number;
}): number {
  if (summary.totalTurns <= 0) return 0;
  return summary.cacheHits / summary.totalTurns;
}
