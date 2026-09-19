/**
 * Phase I (UI redesign) — the persistence half of the AI Usage section.
 *
 * Reads `ai_wallet_settlements` (migration 0153) into the `AiUsageSummary` the
 * `/api/ai/usage` route serves. Tenant-scoped through the same `query` helper
 * every service uses (RLS enforces isolation; the explicit `business_id = $1`
 * predicate is defence in depth and lets the same code read under a superuser
 * test role). No provider call, no mutation — Usage is a read-only lens over
 * the billing the wallet already recorded.
 */
import { query } from "./db";
import { getWalletBalanceRial, getAiDebtRial } from "./wallet-service";
import {
  AI_USAGE_REQUEST_TYPES,
  AI_USAGE_REQUEST_TYPE_LABELS,
  normalizeRequestType,
  type AiUsageByType,
  type AiUsagePricedBy,
  type AiUsageSummary,
  type AiUsageTurn,
  type AiUsageWindowDays,
} from "./ai-usage-shared";

/** How many recent turns the section lists. */
const RECENT_TURNS_LIMIT = 50;

interface TotalsRow extends Record<string, unknown> {
  total_turns: string | number;
  total_charged: string | number;
  total_provider: string | number;
  cache_hits: string | number;
}

interface ByTypeRow extends Record<string, unknown> {
  request_type: string | null;
  turns: string | number;
  charged: string | number;
}

interface TurnRow extends Record<string, unknown> {
  id: string;
  request_type: string | null;
  model: string | null;
  input_tokens: string | number | null;
  output_tokens: string | number | null;
  cache_hit: boolean;
  charged_rial: string | number;
  provider_cost_rial: string | number;
  priced_by: string;
  created_at: string;
}

const num = (v: string | number | null | undefined): number =>
  v == null ? 0 : Number(v);
const numOrNull = (v: string | number | null | undefined): number | null =>
  v == null ? null : Number(v);

/**
 * Summarise a business's AI spend over the trailing `windowDays`.
 *
 * One window predicate (`created_at >= now() - interval`) drives three reads —
 * the totals, the per-origin breakdown, and the recent-turns list — so the
 * chart, the cards and the table always describe the exact same window. The
 * wallet balance and outstanding AI debt come from the wallet service, the one
 * owner of that truth, rather than being recomputed here.
 */
export async function getAiUsageSummary(
  businessId: string,
  windowDays: AiUsageWindowDays,
): Promise<AiUsageSummary> {
  const interval = `${windowDays} days`;

  const [balanceRial, debtRial, totalsResult, byTypeResult, turnsResult] =
    await Promise.all([
      getWalletBalanceRial(businessId),
      getAiDebtRial(businessId),
      query<TotalsRow>(
        `SELECT count(*)                                    AS total_turns,
                coalesce(sum(charged_rial), 0)              AS total_charged,
                coalesce(sum(provider_cost_rial), 0)        AS total_provider,
                count(*) FILTER (WHERE cache_hit)           AS cache_hits
           FROM ai_wallet_settlements
          WHERE business_id = $1
            AND created_at >= now() - $2::interval`,
        [businessId, interval],
      ),
      query<ByTypeRow>(
        `SELECT request_type,
                count(*)                       AS turns,
                coalesce(sum(charged_rial), 0) AS charged
           FROM ai_wallet_settlements
          WHERE business_id = $1
            AND created_at >= now() - $2::interval
          GROUP BY request_type`,
        [businessId, interval],
      ),
      query<TurnRow>(
        `SELECT id, request_type, model, input_tokens, output_tokens,
                cache_hit, charged_rial, provider_cost_rial, priced_by, created_at
           FROM ai_wallet_settlements
          WHERE business_id = $1
            AND created_at >= now() - $2::interval
          ORDER BY created_at DESC
          LIMIT $3`,
        [businessId, interval, RECENT_TURNS_LIMIT],
      ),
    ]);

  const totals = totalsResult.rows[0];

  // Fold the grouped rows into a bucket per known origin so an unknown/legacy
  // request_type is coalesced into `other` rather than shown as a stray slice,
  // then keep only the origins that were actually used, richest first.
  const bucket = new Map<string, { turns: number; charged: number }>();
  for (const row of byTypeResult.rows) {
    const key = normalizeRequestType(row.request_type);
    const prev = bucket.get(key) ?? { turns: 0, charged: 0 };
    prev.turns += num(row.turns);
    prev.charged += num(row.charged);
    bucket.set(key, prev);
  }
  const byType: AiUsageByType[] = AI_USAGE_REQUEST_TYPES.map((requestType) => {
    const slice = bucket.get(requestType) ?? { turns: 0, charged: 0 };
    return {
      requestType,
      label: AI_USAGE_REQUEST_TYPE_LABELS[requestType],
      turns: slice.turns,
      chargedRial: slice.charged,
    };
  })
    .filter((slice) => slice.turns > 0)
    .sort((a, b) => b.chargedRial - a.chargedRial || b.turns - a.turns);

  const recentTurns: AiUsageTurn[] = turnsResult.rows.map((row) => ({
    id: row.id,
    requestType: normalizeRequestType(row.request_type),
    model: row.model,
    inputTokens: numOrNull(row.input_tokens),
    outputTokens: numOrNull(row.output_tokens),
    cacheHit: row.cache_hit,
    chargedRial: num(row.charged_rial),
    providerCostRial: num(row.provider_cost_rial),
    pricedBy: (row.priced_by as AiUsagePricedBy) ?? "token_rate",
    createdAt: row.created_at,
  }));

  return {
    windowDays,
    balanceRial,
    debtRial,
    totalTurns: num(totals?.total_turns),
    totalChargedRial: num(totals?.total_charged),
    totalProviderCostRial: num(totals?.total_provider),
    cacheHits: num(totals?.cache_hits),
    byType,
    recentTurns,
  };
}
