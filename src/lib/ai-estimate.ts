/**
 * Phase 18b Wave 5 — a transparent, conservative cost preview for a user
 * assistant turn. This never reserves or spends credit; the normal turn still
 * reserves the platform-configured maximum atomically before it contacts a
 * provider.
 */
import { buildSystemPrompt, toolDefinitions, type AgentMode, type PromptContext } from "./ai";
import { calculateAiUsageCostRial, estimateTokens, type AiUsageRates } from "./ai-billing";
import type { InboundMessage } from "./ai-service";

export interface AiTurnEstimate {
  estimatedCostRial: number;
  maximumReservationRial: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  assumedToolRounds: number;
  hasTools: boolean;
}

export interface AiTurnEstimateInput {
  mode: AgentMode;
  promptContext: PromptContext;
  messages: InboundMessage[];
  maxOutputTokens: number;
  maxTurnRial: number;
  rates: AiUsageRates;
}

/**
 * Most report questions either answer directly or make one read-tool round
 * before the final answer. The preview therefore models two provider calls
 * when the active mode exposes tools. The exact charge remains the provider's
 * settled token usage, and the returned maximum is the existing atomic hold.
 */
export function estimateAiTurn(input: AiTurnEstimateInput): AiTurnEstimate {
  const tools = toolDefinitions(input.mode);
  const hasTools = tools.length > 0;
  const assumedToolRounds = hasTools ? 2 : 1;
  const providerInput = {
    messages: [
      { role: "system", content: buildSystemPrompt(input.promptContext) },
      ...input.messages,
    ],
    ...(hasTools ? { tools, tool_choice: "auto" } : {}),
  };
  const estimatedInputTokens = estimateTokens(JSON.stringify(providerInput)) * assumedToolRounds;
  const estimatedOutputTokens = Math.max(
    1,
    Math.ceil(Math.max(0, Math.floor(input.maxOutputTokens)) * (hasTools ? 0.65 : 0.5)),
  );
  const rawEstimate = calculateAiUsageCostRial(
    { inputTokens: estimatedInputTokens, outputTokens: estimatedOutputTokens },
    input.rates,
  );

  return {
    estimatedCostRial: Math.min(Math.max(0, Math.floor(input.maxTurnRial)), rawEstimate),
    maximumReservationRial: Math.max(0, Math.floor(input.maxTurnRial)),
    estimatedInputTokens,
    estimatedOutputTokens,
    assumedToolRounds,
    hasTools,
  };
}
