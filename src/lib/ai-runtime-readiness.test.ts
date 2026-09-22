import { describe, expect, it } from "vitest";
import { defaultPlatformConfig, getAiRuntimeReadiness, isPlatformAiConfigured, type PlatformAiConfig } from "./ai-config";

function config(overrides: Partial<PlatformAiConfig> = {}): PlatformAiConfig {
  return {
    ...defaultPlatformConfig(),
    enabled: true,
    model: "pos-chat",
    baseUrl: "http://litellm:4000/v1",
    apiKey: "sk-master",
    maxOutputTokens: 1000,
    maxTurnRial: 50_000,
    gatewayCostingEnabled: true,
    usdRialRate: 600_000,
    ...overrides,
  };
}

describe("canonical AI runtime readiness", () => {
  it("fails closed with stable reasons for disabled and malformed gateways", () => {
    expect(getAiRuntimeReadiness(config({ enabled: false })).reason).toBe("platform_disabled");
    expect(getAiRuntimeReadiness(config({ baseUrl: "" })).reason).toBe("missing_base_url");
    expect(getAiRuntimeReadiness(config({ baseUrl: "litellm:4000" })).reason).toBe("invalid_base_url");
  });

  it("uses the effective tenant virtual key and does not require a master key", () => {
    const resolved = config({
      apiKey: "",
      tenantVirtualKeyRequired: true,
      tenantVirtualKeyResolved: true,
      gateway: { authKey: "sk-tenant", body: {} },
    });
    expect(getAiRuntimeReadiness(resolved)).toMatchObject({ ready: true, authenticationReady: true });
    expect(isPlatformAiConfigured(resolved)).toBe(true);
  });

  it("distinguishes a required missing virtual key from a missing generic credential", () => {
    expect(getAiRuntimeReadiness(config({ tenantVirtualKeyRequired: true, tenantVirtualKeyResolved: false })).reason)
      .toBe("tenant_virtual_key_missing");
    expect(getAiRuntimeReadiness(config({ apiKey: "" })).reason).toBe("missing_runtime_credential");
  });

  it("requires a positive ceiling and a complete costing method", () => {
    expect(getAiRuntimeReadiness(config({ maxTurnRial: 0 })).reason).toBe("max_turn_credit_missing");
    expect(getAiRuntimeReadiness(config({ usdRialRate: null })).reason).toBe("gateway_costing_rate_missing");
    expect(getAiRuntimeReadiness(config({ gatewayCostingEnabled: false, inputCostRialPerMillion: 10, outputCostRialPerMillion: 20 })).ready).toBe(true);
    expect(getAiRuntimeReadiness(config({ gatewayCostingEnabled: false, inputCostRialPerMillion: 10, outputCostRialPerMillion: 0 })).reason).toBe("costing_not_configured");
  });

  it("surfaces database/schema failures without leaking their details", () => {
    expect(getAiRuntimeReadiness(config({ enabled: false, runtimeUnavailableReason: "configuration_load_failed" }))).toMatchObject({
      ready: false,
      reason: "configuration_load_failed",
    });
  });
});
