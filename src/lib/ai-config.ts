/**
 * Phase 18 & Phase 39 — platform-owned AI provider connection (LiteLLM unified gateway).
 *
 * All platform AI settings are stored in `platform_ai_gateway`.
 * This module provides the standard `PlatformAiConfig` reader and predicates
 * used by runtime resolvers, billing/costing, and the platform admin console.
 */
import {
  defaultConfig,
  PROVIDERS,
  validateConfigInput,
  type AiConfig,
  type AiProvider,
} from "./ai";
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
}

export interface PublicPlatformAiConfig {
  enabled: boolean;
  provider: AiProvider;
  model: string;
  baseUrl: string;
  temperature: number;
  maxOutputTokens: number;
  inputCostRialPerMillion: number;
  outputCostRialPerMillion: number;
  revenueMarginPercent: number;
  inputTokenRialPerMillion: number;
  outputTokenRialPerMillion: number;
  maxTurnRial: number;
  hasApiKey: boolean;
  configured: boolean;
}

export interface PlatformAiConfigInput {
  enabled: boolean;
  provider?: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  temperature: number;
  inputCostRialPerMillion: number;
  outputCostRialPerMillion: number;
  revenueMarginPercent: number;
  maxTurnRial: number;
  maxOutputTokens: number;
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
};

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
  };
}

/** The global config used by every business's assistant call. */
export async function getPlatformAiConfig(): Promise<PlatformAiConfig> {
  try {
    const { rows } = await query<GatewayConfigRow>(
      `SELECT enabled, chat_model, base_url, master_key, temperature,
              input_cost_rial_per_million, output_cost_rial_per_million,
              revenue_margin_percent, max_turn_rial, max_output_tokens
         FROM platform_ai_gateway
        WHERE id = true`,
    );
    return rows[0] ? rowToConfig(rows[0]) : defaultPlatformConfig();
  } catch {
    return defaultPlatformConfig();
  }
}

/** A provider connection that may serve the platform support agent. */
export function isPlatformAiProviderReady(config: PlatformAiConfig): boolean {
  return config.enabled && Boolean(config.apiKey) && config.maxOutputTokens >= 64;
}

/** Whether a global provider can safely make metered tenant requests. */
export function isPlatformAiConfigured(config: PlatformAiConfig): boolean {
  return (
    isPlatformAiProviderReady(config) &&
    config.inputCostRialPerMillion > 0 &&
    config.outputCostRialPerMillion > 0 &&
    config.maxTurnRial > 0
  );
}

export function toPublicPlatformAiConfig(config: PlatformAiConfig): PublicPlatformAiConfig {
  return {
    enabled: config.enabled,
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    temperature: config.temperature,
    maxOutputTokens: config.maxOutputTokens,
    inputCostRialPerMillion: config.inputCostRialPerMillion,
    outputCostRialPerMillion: config.outputCostRialPerMillion,
    revenueMarginPercent: config.revenueMarginPercent,
    inputTokenRialPerMillion: config.inputTokenRialPerMillion,
    outputTokenRialPerMillion: config.outputTokenRialPerMillion,
    maxTurnRial: config.maxTurnRial,
    hasApiKey: Boolean(config.apiKey),
    configured: isPlatformAiConfigured(config),
  };
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function validatePlatformAiConfigInput(input: PlatformAiConfigInput): string[] {
  const errors = validateConfigInput({ ...input, provider: "litellm" });
  if (typeof input.enabled !== "boolean") errors.push("ai_bad_enabled");
  if (!positiveInteger(input.inputCostRialPerMillion)) errors.push("ai_bad_input_cost");
  if (!positiveInteger(input.outputCostRialPerMillion)) errors.push("ai_bad_output_cost");
  if (
    !Number.isFinite(input.revenueMarginPercent) ||
    input.revenueMarginPercent < 0 ||
    input.revenueMarginPercent > 1000
  ) {
    errors.push("ai_bad_margin");
  }
  if (!positiveInteger(input.maxTurnRial)) errors.push("ai_bad_max_turn");
  if (
    !Number.isSafeInteger(input.maxOutputTokens) ||
    input.maxOutputTokens < 64 ||
    input.maxOutputTokens > 8192
  ) {
    errors.push("ai_bad_max_tokens");
  }
  return errors;
}

/**
 * Persist platform configuration. A blank key preserves the existing key so an
 * owner can change model/pricing without sending a secret back through the UI.
 */
export async function savePlatformAiConfig(input: PlatformAiConfigInput): Promise<PlatformAiConfig> {
  const current = await getPlatformAiConfig();
  const apiKey = input.apiKey?.trim() || current.apiKey || null;
  await query(
    `INSERT INTO platform_ai_gateway
       (id, enabled, chat_model, base_url, master_key, temperature,
        input_cost_rial_per_million, output_cost_rial_per_million,
        revenue_margin_percent, max_turn_rial, max_output_tokens, updated_at)
     VALUES
       (true, $1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10, now())
     ON CONFLICT (id)
     DO UPDATE SET enabled = EXCLUDED.enabled,
                   chat_model = EXCLUDED.chat_model,
                   base_url = EXCLUDED.base_url,
                   master_key = EXCLUDED.master_key,
                   temperature = EXCLUDED.temperature,
                   input_cost_rial_per_million = EXCLUDED.input_cost_rial_per_million,
                   output_cost_rial_per_million = EXCLUDED.output_cost_rial_per_million,
                   revenue_margin_percent = EXCLUDED.revenue_margin_percent,
                   max_turn_rial = EXCLUDED.max_turn_rial,
                   max_output_tokens = EXCLUDED.max_output_tokens,
                   updated_at = now()`,
    [
      input.enabled,
      input.model.trim(),
      input.baseUrl.trim(),
      apiKey,
      input.temperature,
      input.inputCostRialPerMillion,
      input.outputCostRialPerMillion,
      input.revenueMarginPercent,
      input.maxTurnRial,
      input.maxOutputTokens,
    ],
  );
  return getPlatformAiConfig();
}
