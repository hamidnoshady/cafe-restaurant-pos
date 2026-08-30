/**
 * Phase 37 — the one place that turns stored configuration into the `AiConfig`
 * a call actually goes out with.
 *
 * Every AI surface in the product (the chat turn, the receipt extraction, the
 * RAG embedding, the proactive digests, autopilot, the estimate) currently
 * calls `getPlatformAiConfig()` and hands the result straight to the provider
 * client. This module is the seam they should call instead: it returns the
 * same object, with the gateway's per-call decisions already applied, and it
 * is a no-op unless the platform is actually running through a gateway.
 *
 * The failure policy is the important part. A gateway is a component the
 * deployment added on purpose, but it is still a component that can be down,
 * unreachable, or misconfigured while the upstream connection itself is fine.
 * Anything that goes wrong resolving gateway state therefore degrades to the
 * platform configuration and logs — it never takes the assistant down with it,
 * because before this phase existed there was no gateway to fail and the
 * assistant worked.
 */
import { getPlatformAiConfig, type PlatformAiConfig } from "./ai-config";
import { getAiGatewayConfig, getBusinessGateway } from "./ai-gateway-service";
import { buildGatewayRuntime, isGatewayActive } from "./ai-gateway";
import type { AiConfig } from "./ai";

/**
 * The config for a tenant call. `businessId` scopes which virtual key is used;
 * pass null for the platform support agent, which runs on the shared
 * connection by definition. `mode` is the agent surface the call answers on —
 * Phase 38b's prompt bindings are per surface, so a bound surface's runtime
 * carries its gateway `promptId`.
 */
export async function resolveAiConfigFor(
  businessId: string | null,
  mode?: string | null,
): Promise<PlatformAiConfig> {
  const config = await getPlatformAiConfig();
  return decorate(config, businessId, mode);
}

/**
 * Apply gateway state to an already-loaded config. Exported for the surfaces
 * that fetch the platform config themselves for other reasons (the proactive
 * service checks `isPlatformAiConfigured` first, for instance) and would
 * otherwise read it twice.
 */
export async function decorateAiConfig(
  config: PlatformAiConfig,
  businessId: string | null,
  mode?: string | null,
): Promise<PlatformAiConfig> {
  return decorate(config, businessId, mode);
}

async function decorate(config: PlatformAiConfig, businessId: string | null, mode?: string | null): Promise<PlatformAiConfig> {
  if (!businessId) return config;
  let gateway;
  let business = null;
  try {
    gateway = await getAiGatewayConfig();
    if (!isGatewayActive(gateway)) return config;
    business = await getBusinessGateway(businessId);
  } catch (err) {
    // The gateway is an addition, not a dependency: a failure to read its
    // state must leave the existing connection exactly as it was.
    console.error("ai gateway state unavailable; using the platform connection unchanged", err);
    return config;
  }

  const runtime = buildGatewayRuntime({ config, gateway, business, mode });
  if (!runtime) return config;

  const { model, embeddingModel, body, authKey, promptId } = runtime;
  const decorated: AiConfig = {
    ...config,
    model,
    embeddingModel,
    gateway: {
      ...(authKey ? { authKey } : {}),
      body,
      ...(promptId ? { promptId } : {}),
    },
  };
  return decorated as PlatformAiConfig;
}
