/**
 * DB-backed AI assistant configuration, merged with env fallbacks.
 *
 * Stored (business-wide) under settings key `ai.config`. Env vars provide a
 * fallback so an operator can wire keys at deploy time without the UI:
 *   AI_PROVIDER, AI_MODEL, AI_BASE_URL, AI_TEMPERATURE,
 *   OPENROUTER_API_KEY, ARVAN_AI_API_KEY.
 */
import {
  defaultConfig,
  isProvider,
  PROVIDERS,
  type AiConfig,
  type AiProvider,
} from "./ai";
import { getSetting, setSetting, SETTING_KEYS } from "./settings";

type StoredAiConfig = Partial<AiConfig>;

function envKeyFor(provider: AiProvider): string {
  return process.env[PROVIDERS[provider].keyEnv]?.trim() ?? "";
}

/** Resolve the effective config: DB row on top of env/provider defaults. */
export async function getAiConfig(businessId: string): Promise<AiConfig> {
  const stored = (await getSetting<StoredAiConfig>(businessId, SETTING_KEYS.aiConfig)) ?? {};

  const provider: AiProvider = isProvider(stored.provider)
    ? stored.provider
    : isProvider(process.env.AI_PROVIDER)
      ? (process.env.AI_PROVIDER as AiProvider)
      : "openrouter";

  const base = defaultConfig(provider);
  const envTemp = Number(process.env.AI_TEMPERATURE);

  const apiKey = stored.apiKey?.trim() || envKeyFor(provider);

  return {
    enabled: stored.enabled ?? Boolean(apiKey),
    provider,
    model: stored.model?.trim() || process.env.AI_MODEL?.trim() || base.model,
    baseUrl: stored.baseUrl?.trim() || process.env.AI_BASE_URL?.trim() || base.baseUrl,
    apiKey,
    temperature:
      typeof stored.temperature === "number"
        ? stored.temperature
        : Number.isFinite(envTemp)
          ? envTemp
          : base.temperature,
  };
}

/**
 * Persist config. An empty/blank apiKey is treated as "keep the existing key"
 * so the UI can save other fields without re-typing the secret (the browser
 * never receives the stored key back).
 */
export async function saveAiConfig(
  businessId: string,
  input: {
    enabled: boolean;
    provider: AiProvider;
    model: string;
    baseUrl: string;
    apiKey?: string;
    temperature: number;
  },
): Promise<AiConfig> {
  const existing = (await getSetting<StoredAiConfig>(businessId, SETTING_KEYS.aiConfig)) ?? {};
  const nextKey = input.apiKey && input.apiKey.trim() ? input.apiKey.trim() : (existing.apiKey ?? "");

  const value: AiConfig = {
    enabled: input.enabled,
    provider: input.provider,
    model: input.model.trim(),
    baseUrl: input.baseUrl.trim(),
    apiKey: nextKey,
    temperature: input.temperature,
  };
  await setSetting(businessId, SETTING_KEYS.aiConfig, value);
  return value;
}
