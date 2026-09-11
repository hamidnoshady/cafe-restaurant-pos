/**
 * Phase 18 & Phase 39 — platform-owned AI provider connection (LiteLLM unified gateway).
 *
 * All platform AI settings are stored in `platform_ai_gateway`.
 * This module is the runtime's read side: the standard `PlatformAiConfig`
 * reader and the predicates used by runtime resolvers and billing. The only
 * editor of that row is the LiteLLM settings page in the platform console.
 */
import { defaultConfig, type AiConfig, type AiProvider } from "./ai";
import { query } from "./db";

export interface PlatformAiConfig extends AiConfig {
  /** The provider's own cost per million input tokens, Rial. */
  inputCostRialPerMillion: number;
  /** The provider's own cost per million output tokens, Rial. */
  outputCostRialPerMillion: number;
  /** The revenue margin added on top of cost, percent. 0 = at cost. */
  revenueMarginPercent: number;
  /** Effective sale rate: cost + margin. Derived, never stored. */
  inputTokenRialPerMillion: number;
  outputTokenRialPerMillion: number;
  maxTurnRial: number;
  /** Fixed at 1 since the credit-package catalogue was removed: a credit is a Rial. */
  creditUnitRial: number;
  maxOutputTokens: number;
  /**
   * LiteLLM-driven costing: when on, the platform prices each turn from the
   * gateway's own reported USD cost converted at `usdRialRate`, and the manual
   * per-million token rates are only a fallback. This is the intended mode —
   * cost-plus-margin lives inside LiteLLM and the platform merely converts and
   * decrements the business's Rial credit.
   */
  gatewayCostingEnabled: boolean;
  /** FX rate turning the gateway's USD cost into Rial. */
  usdRialRate: number | null;
}

type GatewayConfigRow = {
  enabled: boolean;
  chat_model: string;
  base_url: string;
  master_key: string | null;
  temperature: string | number;
  input_cost_rial_per_million: string | number;
  output_cost_rial_per_million: string | number;
  revenue_margin_percent: string | number;
  max_turn_rial: string | number;
  max_output_tokens: number;
  gateway_costing_enabled: boolean;
  usd_rial_rate: string | number | null;
};

function optionalPositiveNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function numberValue(value: string | number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function envNumber(name: string): number {
  return numberValue(process.env[name]);
}

function envKey(): string {
  return (
    process.env.LITELLM_MASTER_KEY?.trim() ||
    process.env.AI_API_KEY?.trim() ||
    ""
  );
}

/**
 * Cost-plus pricing: the sale rate is the provider cost with the platform's
 * revenue margin on top, rounded up so a turn never sells below cost.
 */
export function effectiveRate(costRialPerMillion: number, marginPercent: number): number {
  if (!(costRialPerMillion > 0)) return 0;
  return Math.ceil(costRialPerMillion * (1 + (marginPercent || 0) / 100));
}

export function defaultPlatformConfig(): PlatformAiConfig {
  const base = defaultConfig("litellm");
  const temp = envNumber("AI_TEMPERATURE");
  const maxOutputTokens = envNumber("AI_MAX_OUTPUT_TOKENS");
  return {
    ...base,
    enabled: process.env.AI_ENABLED === "true",
    model: process.env.AI_MODEL?.trim() || base.model,
    baseUrl: process.env.AI_BASE_URL?.trim() || process.env.LITELLM_BASE_URL?.trim() || base.baseUrl,
    apiKey: envKey(),
    temperature: temp >= 0 && temp <= 2 ? temp : base.temperature,
    inputCostRialPerMillion: envNumber("AI_INPUT_COST_RIAL_PER_MILLION"),
    outputCostRialPerMillion: envNumber("AI_OUTPUT_COST_RIAL_PER_MILLION"),
    revenueMarginPercent: envNumber("AI_REVENUE_MARGIN_PERCENT"),
    inputTokenRialPerMillion: effectiveRate(
      envNumber("AI_INPUT_COST_RIAL_PER_MILLION"),
      envNumber("AI_REVENUE_MARGIN_PERCENT"),
    ),
    outputTokenRialPerMillion: effectiveRate(
      envNumber("AI_OUTPUT_COST_RIAL_PER_MILLION"),
      envNumber("AI_REVENUE_MARGIN_PERCENT"),
    ),
    maxTurnRial: envNumber("AI_MAX_TURN_RIAL"),
    creditUnitRial: 1,
    maxOutputTokens:
      Number.isInteger(maxOutputTokens) && maxOutputTokens >= 64 && maxOutputTokens <= 8192
        ? maxOutputTokens
        : 1000,
    gatewayCostingEnabled: process.env.LITELLM_GATEWAY_COSTING_ENABLED === "true",
    usdRialRate: optionalPositiveNumber(process.env.LITELLM_USD_RIAL_RATE),
  };
}

function rowToConfig(row: GatewayConfigRow): PlatformAiConfig {
  const fallback = defaultPlatformConfig();
  const base = defaultConfig("litellm");
  return {
    enabled: row.enabled,
    provider: "litellm",
    model: row.chat_model?.trim() || fallback.model || base.model,
    baseUrl: row.base_url?.trim() || fallback.baseUrl || base.baseUrl,
    apiKey: row.master_key?.trim() || fallback.apiKey || "",
    temperature: numberValue(row.temperature),
    inputCostRialPerMillion: numberValue(row.input_cost_rial_per_million),
    outputCostRialPerMillion: numberValue(row.output_cost_rial_per_million),
    revenueMarginPercent: numberValue(row.revenue_margin_percent),
    inputTokenRialPerMillion: effectiveRate(
      numberValue(row.input_cost_rial_per_million),
      numberValue(row.revenue_margin_percent),
    ),
    outputTokenRialPerMillion: effectiveRate(
      numberValue(row.output_cost_rial_per_million),
      numberValue(row.revenue_margin_percent),
    ),
    maxTurnRial: numberValue(row.max_turn_rial),
    creditUnitRial: 1,
    maxOutputTokens: row.max_output_tokens || 1000,
    gatewayCostingEnabled: Boolean(row.gateway_costing_enabled),
    usdRialRate: optionalPositiveNumber(row.usd_rial_rate),
  };
}

/** The global config used by every business's assistant call. */
export async function getPlatformAiConfig(): Promise<PlatformAiConfig> {
  try {
    const { rows } = await query<GatewayConfigRow>(
      `SELECT enabled, chat_model, base_url, master_key, temperature,
              input_cost_rial_per_million, output_cost_rial_per_million,
              revenue_margin_percent, max_turn_rial, max_output_tokens,
              gateway_costing_enabled, usd_rial_rate
         FROM platform_ai_gateway
        WHERE id = true`,
    );
    return rows[0] ? rowToConfig(rows[0]) : defaultPlatformConfig();
  } catch (err) {
    // Fail closed, not into the environment's defaults: a query error here
    // (a column missing because 0124 hasn't run yet, a connection blip) is a
    // real fault, and `defaultPlatformConfig()`'s `AI_ENABLED` env fallback
    // could silently report the assistant as on when the actual DB-backed
    // config just failed to load. Log it and disable, matching ai-runtime.ts's
    // own fail-closed rule for gateway/branch state.
    console.error("platform AI config unavailable; failing closed", err);
    return { ...defaultPlatformConfig(), enabled: false };
  }
}

/** A provider connection that may serve the platform support agent. */
export function isPlatformAiProviderReady(config: PlatformAiConfig): boolean {
  return config.enabled && Boolean(config.apiKey) && config.maxOutputTokens >= 64;
}

/**
 * Whether a global provider can safely make metered tenant requests.
 *
 * There are two valid pricing modes and a turn may reserve credit under either:
 *
 *  - **LiteLLM-driven costing (intended):** cost-plus-margin is configured
 *    inside LiteLLM, which reports each turn's USD cost. The platform only needs
 *    a USD→Rial rate and a per-turn reservation ceiling to convert and decrement
 *    the business's credit — the manual token rates may be zero.
 *  - **Manual token rates (fallback):** the platform prices turns from its own
 *    per-million input/output rates when the gateway does not report a cost.
 *
 * A per-turn ceiling (`maxTurnRial`) is required either way: it is the amount
 * reserved up front and released back down to the actual cost at settlement.
 */
export function isPlatformAiConfigured(config: PlatformAiConfig): boolean {
  if (!isPlatformAiProviderReady(config)) return false;
  if (!(config.maxTurnRial > 0)) return false;
  const gatewayCosting = config.gatewayCostingEnabled && (config.usdRialRate ?? 0) > 0;
  const tokenRates = config.inputCostRialPerMillion > 0 && config.outputCostRialPerMillion > 0;
  return gatewayCosting || tokenRates;
}
