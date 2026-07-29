/**
 * Phase 18 — one platform-owned AI provider connection.
 *
 * The old per-business settings row is deliberately gone. This singleton is
 * read by tenant assistant calls but can only be written through the platform
 * console; no business-facing response includes its API key.
 */
import {
  defaultConfig,
  isProvider,
  PROVIDERS,
  validateConfigInput,
  type AiConfig,
  type AiProvider,
} from "./ai";
import { query } from "./db";

export interface PlatformAiConfig extends AiConfig {
  inputTokenRialPerMillion: number;
  outputTokenRialPerMillion: number;
  maxTurnRial: number;
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
  inputTokenRialPerMillion: number;
  outputTokenRialPerMillion: number;
  maxTurnRial: number;
  creditUnitRial: number;
  hasApiKey: boolean;
  configured: boolean;
}

export interface PlatformAiConfigInput {
  enabled: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  temperature: number;
  inputTokenRialPerMillion: number;
  outputTokenRialPerMillion: number;
  maxTurnRial: number;
  creditUnitRial: number;
  maxOutputTokens: number;
}

type ConfigRow = {
  enabled: boolean;
  provider: string;
  model: string;
  base_url: string;
  api_key: string | null;
  temperature: string | number;
  input_token_rial_per_million: string | number;
  output_token_rial_per_million: string | number;
  max_turn_rial: string | number;
  credit_unit_rial: string | number;
  max_output_tokens: number;
};

function numberValue(value: string | number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function envNumber(name: string): number {
  return numberValue(process.env[name]);
}

function envKeyFor(provider: AiProvider): string {
  return process.env[PROVIDERS[provider].keyEnv]?.trim() ?? "";
}

function defaultPlatformConfig(): PlatformAiConfig {
  const provider: AiProvider = isProvider(process.env.AI_PROVIDER)
    ? (process.env.AI_PROVIDER as AiProvider)
    : "openrouter";
  const base = defaultConfig(provider);
  const temp = envNumber("AI_TEMPERATURE");
  const maxOutputTokens = envNumber("AI_MAX_OUTPUT_TOKENS");
  return {
    ...base,
    enabled: process.env.AI_ENABLED === "true",
    model: process.env.AI_MODEL?.trim() || base.model,
    baseUrl: process.env.AI_BASE_URL?.trim() || base.baseUrl,
    apiKey: envKeyFor(provider),
    temperature: temp >= 0 && temp <= 2 ? temp : base.temperature,
    inputTokenRialPerMillion: envNumber("AI_INPUT_TOKEN_RIAL_PER_MILLION"),
    outputTokenRialPerMillion: envNumber("AI_OUTPUT_TOKEN_RIAL_PER_MILLION"),
    maxTurnRial: envNumber("AI_MAX_TURN_RIAL"),
    creditUnitRial: envNumber("AI_CREDIT_UNIT_RIAL"),
    maxOutputTokens:
      Number.isInteger(maxOutputTokens) && maxOutputTokens >= 64 && maxOutputTokens <= 8192
        ? maxOutputTokens
        : 1000,
  };
}

function rowToConfig(row: ConfigRow): PlatformAiConfig {
  const fallback = defaultPlatformConfig();
  const provider = isProvider(row.provider) ? row.provider : fallback.provider;
  const base = defaultConfig(provider);
  return {
    enabled: row.enabled,
    provider,
    model: row.model?.trim() || base.model,
    baseUrl: row.base_url?.trim() || base.baseUrl,
    apiKey: row.api_key?.trim() || envKeyFor(provider),
    temperature: numberValue(row.temperature),
    inputTokenRialPerMillion: numberValue(row.input_token_rial_per_million),
    outputTokenRialPerMillion: numberValue(row.output_token_rial_per_million),
    maxTurnRial: numberValue(row.max_turn_rial),
    creditUnitRial: numberValue(row.credit_unit_rial),
    maxOutputTokens: row.max_output_tokens,
  };
}

/** The global config used by every business's assistant call. */
export async function getPlatformAiConfig(): Promise<PlatformAiConfig> {
  const { rows } = await query<ConfigRow>(
    `SELECT enabled, provider, model, base_url, api_key, temperature,
            input_token_rial_per_million, output_token_rial_per_million,
            max_turn_rial, credit_unit_rial, max_output_tokens
       FROM platform_ai_config
      WHERE id = true`,
  );
  return rows[0] ? rowToConfig(rows[0]) : defaultPlatformConfig();
}

/** Whether a global provider can safely make metered requests. */
export function isPlatformAiConfigured(config: PlatformAiConfig): boolean {
  return (
    config.enabled &&
    Boolean(config.apiKey) &&
    config.inputTokenRialPerMillion > 0 &&
    config.outputTokenRialPerMillion > 0 &&
    config.maxTurnRial > 0 &&
    config.creditUnitRial > 0 &&
    config.maxOutputTokens >= 64
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
    inputTokenRialPerMillion: config.inputTokenRialPerMillion,
    outputTokenRialPerMillion: config.outputTokenRialPerMillion,
    maxTurnRial: config.maxTurnRial,
    creditUnitRial: config.creditUnitRial,
    hasApiKey: Boolean(config.apiKey),
    configured: isPlatformAiConfigured(config),
  };
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function validatePlatformAiConfigInput(input: PlatformAiConfigInput): string[] {
  const errors = validateConfigInput(input);
  if (typeof input.enabled !== "boolean") errors.push("ai_bad_enabled");
  if (!positiveInteger(input.inputTokenRialPerMillion)) errors.push("ai_bad_input_rate");
  if (!positiveInteger(input.outputTokenRialPerMillion)) errors.push("ai_bad_output_rate");
  if (!positiveInteger(input.maxTurnRial)) errors.push("ai_bad_max_turn");
  if (!positiveInteger(input.creditUnitRial)) errors.push("ai_bad_credit_unit");
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
  const provider = input.provider as AiProvider;
  await query(
    `INSERT INTO platform_ai_config
       (id, enabled, provider, model, base_url, api_key, temperature,
        input_token_rial_per_million, output_token_rial_per_million,
        max_turn_rial, credit_unit_rial, max_output_tokens, updated_at)
     VALUES
       (true, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
     ON CONFLICT (id)
     DO UPDATE SET enabled = EXCLUDED.enabled,
                   provider = EXCLUDED.provider,
                   model = EXCLUDED.model,
                   base_url = EXCLUDED.base_url,
                   api_key = EXCLUDED.api_key,
                   temperature = EXCLUDED.temperature,
                   input_token_rial_per_million = EXCLUDED.input_token_rial_per_million,
                   output_token_rial_per_million = EXCLUDED.output_token_rial_per_million,
                   max_turn_rial = EXCLUDED.max_turn_rial,
                   credit_unit_rial = EXCLUDED.credit_unit_rial,
                   max_output_tokens = EXCLUDED.max_output_tokens,
                   updated_at = now()`,
    [
      input.enabled,
      provider,
      input.model.trim(),
      input.baseUrl.trim(),
      apiKey,
      input.temperature,
      input.inputTokenRialPerMillion,
      input.outputTokenRialPerMillion,
      input.maxTurnRial,
      input.creditUnitRial,
      input.maxOutputTokens,
    ],
  );
  return getPlatformAiConfig();
}
