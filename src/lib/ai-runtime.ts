/**
 * Phase 37 & Phase 39 — the one place that turns stored configuration into the `AiConfig`
 * a call actually goes out with.
 *
 * Resolves AI configuration with branch -> business -> platform fallback hierarchy.
 * In Phase 39 (LiteLLM-only), if the gateway or DB state fails to resolve, we fail closed
 * (enabled: false) to prevent unbilled or uncontrolled vendor execution.
 */
import { getPlatformAiConfig, type PlatformAiConfig } from "./ai-config";
import { getAiGatewayConfig, getBusinessGateway } from "./ai-gateway-service";
import { buildGatewayRuntime, isGatewayActive } from "./ai-gateway";
import type { AiConfig } from "./ai";

/**
 * The config for a tenant call.
 * `businessId` scopes which virtual key is used; pass null for platform support.
 * `locationId` scopes branch-level model overrides and branch virtual keys.
 */
export async function resolveAiConfigFor(
  businessId: string | null,
  locationId?: string | null,
): Promise<PlatformAiConfig> {
  const config = await getPlatformAiConfig();
  return decorate(config, businessId, locationId);
}

/**
 * Apply gateway state to an already-loaded config.
 */
export async function decorateAiConfig(
  config: PlatformAiConfig,
  businessId: string | null,
  locationId?: string | null,
): Promise<PlatformAiConfig> {
  return decorate(config, businessId, locationId);
}

async function decorate(
  config: PlatformAiConfig,
  businessId: string | null,
  locationId?: string | null,
): Promise<PlatformAiConfig> {
  if (!config.enabled) return config;

  let gateway;
  let business = null;
  let branch = null;
  try {
    gateway = await getAiGatewayConfig();
    if (!isGatewayActive(gateway)) {
      // Gateway is disabled or has no base_url
      return { ...config, enabled: false };
    }
    if (businessId) {
      business = await getBusinessGateway(businessId, null);
      if (locationId) {
        branch = await getBusinessGateway(businessId, locationId);
      }
    }
  } catch (err) {
    console.error("ai gateway state unavailable; failing closed", err);
    return { ...config, enabled: false };
  }

  const runtime = buildGatewayRuntime({ config, gateway, business, branch });
  if (!runtime) return config;

  const { model, embeddingModel, body, authKey } = runtime;
  const decorated: AiConfig = {
    ...config,
    model,
    embeddingModel,
    gateway: {
      ...(authKey ? { authKey } : {}),
      body,
    },
  };
  return decorated as PlatformAiConfig;
}
