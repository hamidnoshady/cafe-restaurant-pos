/**
 * AI Operating Layer — Phase B billing orchestration.
 *
 * The one place that turns a finished AI turn into a charge against the ONE
 * platform wallet. It replaces the old reserve→settle→cancel flow
 * (`ai-billing-service.ts`) that debited a separate `ai_business_billing`
 * balance up front at the maximum turn amount and refunded the remainder.
 *
 * The new flow (rebuild Parts 2 & 3):
 *
 *   gateAiTurn()      before the request — refuse when the wallet cannot
 *                     afford AI (blocks the next request when in debt).
 *   settleAiTurn()    after the request  — compute the REAL cost from the
 *                     gateway's reported USD (LiteLLM), or the token-rate
 *                     fallback when the gateway did not price the turn, then
 *                     debit the wallet through wallet-service.
 *
 * Cost policy:
 *   - LiteLLM is the source of truth for provider/model cost. When the gateway
 *     reports a per-turn USD figure and gateway costing is on, that figure
 *     (converted to Rial + the platform's optional commercial margin) is the
 *     charge — the application does NOT re-derive what OpenAI/Anthropic charged.
 *   - When the gateway did not report a cost (direct vendor, costing off, or a
 *     provider that omitted it), the platform's per-token Rial rate is the
 *     documented fallback, exactly as before.
 */

import { randomUUID } from "node:crypto";
import { calculateAiUsageCostRial, type AiTokenUsage } from "./ai-billing";
import { resolveGatewayTurnPricing } from "./ai-gateway-service";
import {
  checkAiAffordability,
  settleAiWalletCharge,
  type AiSettlementResult,
} from "./wallet-service";

/** Raised by `gateAiTurn` when the wallet cannot afford another AI turn. */
export class AiWalletInsufficientError extends Error {
  constructor(
    public balanceRial: number,
    public debtRial: number,
    public requiredRial: number,
  ) {
    super("ai_wallet_insufficient");
  }
}

/** The pricing inputs a turn carries from its resolved AiConfig. */
export interface AiTurnPricingConfig {
  /** Per-turn ceiling, reused as the minimum-balance affordability guard. */
  maxTurnRial: number;
  inputTokenRialPerMillion: number;
  outputTokenRialPerMillion: number;
  revenueMarginPercent: number;
}

export interface AiTurnAttribution {
  requestType?: string;
  model?: string | null;
  conversationId?: string | null;
  projectId?: string | null;
  agentId?: string | null;
  automationId?: string | null;
  coworkerId?: string | null;
  locationId?: string | null;
  userId?: string | null;
  note?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Pre-request gate. Throws `AiWalletInsufficientError` when the business is in
 * AI debt or its balance is below the per-turn ceiling. A zero ceiling means
 * "no minimum" — only outstanding debt blocks.
 */
export async function gateAiTurn(
  businessId: string,
  config: AiTurnPricingConfig,
): Promise<void> {
  const required = Math.max(0, Math.floor(config.maxTurnRial));
  const check = await checkAiAffordability(businessId, required);
  if (!check.affordable) {
    throw new AiWalletInsufficientError(check.balanceRial, check.debtRial, check.requiredRial);
  }
}

/** Allocate a per-turn request id before the request begins. */
export function newAiRequestId(): string {
  return randomUUID();
}

/**
 * Settle a finished turn against the wallet. `costUsd` is the gateway's
 * reported figure (or null); `usage` is the token count used for the fallback.
 * Returns the wallet settlement result (what was charged, any new debt).
 */
export async function settleAiTurn(input: {
  businessId: string;
  requestId: string;
  config: AiTurnPricingConfig;
  usage: AiTokenUsage;
  costUsd?: number | null;
  litellmCallId?: string | null;
  cacheHit?: boolean;
  attribution?: AiTurnAttribution;
}): Promise<AiSettlementResult> {
  const attribution = input.attribution ?? {};

  // Prefer the gateway's real cost; fall back to the platform token rates.
  const gatewayPricing = await resolveGatewayTurnPricing(
    input.costUsd,
    input.config.revenueMarginPercent,
  );

  let chargedRial: number;
  let providerCostRial = 0;
  let pricedBy: "gateway" | "token_rate" | "free";
  if (gatewayPricing) {
    chargedRial = Math.max(0, Math.ceil(gatewayPricing.chargedRial));
    providerCostRial = Math.max(0, Math.ceil(gatewayPricing.costRial));
    pricedBy = "gateway";
  } else {
    chargedRial = calculateAiUsageCostRial(input.usage, {
      inputTokenRialPerMillion: input.config.inputTokenRialPerMillion,
      outputTokenRialPerMillion: input.config.outputTokenRialPerMillion,
    });
    providerCostRial = chargedRial;
    pricedBy = chargedRial > 0 ? "token_rate" : "free";
  }

  return settleAiWalletCharge({
    businessId: input.businessId,
    requestId: input.requestId,
    chargedRial,
    providerCostRial,
    costUsd: gatewayPricing ? input.costUsd ?? null : null,
    pricedBy,
    litellmCallId: input.litellmCallId ?? null,
    cacheHit: input.cacheHit ?? false,
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    requestType: attribution.requestType,
    model: attribution.model,
    conversationId: attribution.conversationId,
    projectId: attribution.projectId,
    agentId: attribution.agentId,
    automationId: attribution.automationId,
    coworkerId: attribution.coworkerId,
    locationId: attribution.locationId,
    userId: attribution.userId,
    note: attribution.note,
    metadata: attribution.metadata,
  });
}
