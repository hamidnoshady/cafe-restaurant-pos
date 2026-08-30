/**
 * Unit tests for the gateway layer's pure half.
 *
 * The gateway is an optional component sitting in front of an already-working
 * provider client, so the property that matters most is not what it does when
 * configured but that it does *nothing at all* when it isn't: no extra body
 * fields, no substituted key, no rewritten model. Those cases come first.
 */
import { describe, expect, it } from "vitest";
import {
  buildGatewayRuntime,
  defaultGatewayConfig,
  emptyBusinessGateway,
  gatewayManagementUrl,
  gatewayRequestBody,
  gatewayStatusMessage,
  isValidBudgetDuration,
  keyInfoUrl,
  keyModelsFor,
  livelinessUrl,
  modelInfoUrl,
  normaliseBusinessGatewayInput,
  parseGatewayModels,
  parseGeneratedKey,
  parseKeySpend,
  resolveChatModel,
  resolveEmbeddingModel,
  resolveGatewayAuthKey,
  toListText,
  toPublicGatewayConfig,
  toStringList,
  validateBusinessGatewayInput,
  validateGatewayInput,
  virtualKeyAlias,
  type AiGatewayConfig,
  type BusinessGateway,
} from "./ai-gateway";
import { defaultConfig, isProvider, PROVIDERS, type AiConfig } from "./ai";

function gateway(overrides: Partial<AiGatewayConfig> = {}): AiGatewayConfig {
  return { ...defaultGatewayConfig(), enabled: true, ...overrides };
}

function business(overrides: Partial<BusinessGateway> = {}): BusinessGateway {
  return { ...emptyBusinessGateway("b1"), ...overrides };
}

const platform: AiConfig = { ...defaultConfig("litellm"), apiKey: "sk-platform", model: "gpt-4o-mini" };

describe("provider catalogue", () => {
  it("accepts litellm as a provider and marks it as a gateway", () => {
    expect(isProvider("litellm")).toBe(true);
    expect(PROVIDERS.litellm.isGateway).toBe(true);
    expect(PROVIDERS.openrouter.isGateway).toBeUndefined();
  });

  it("keeps the two direct vendors' defaults untouched", () => {
    expect(PROVIDERS.openrouter.defaultBaseUrl).toBe("https://openrouter.ai/api/v1");
    expect(PROVIDERS.arvan.defaultBaseUrl).toBe("https://ai.arvancloud.ir/v1");
  });
});

describe("an inactive gateway changes nothing", () => {
  it("produces no runtime at all when the gateway is absent", () => {
    expect(buildGatewayRuntime({ config: platform, gateway: null, business: null })).toBeUndefined();
  });

  it("produces no runtime when the gateway row exists but is switched off", () => {
    expect(
      buildGatewayRuntime({ config: platform, gateway: defaultGatewayConfig(), business: null }),
    ).toBeUndefined();
  });

  it("sends no extra body fields to a direct vendor", () => {
    expect(gatewayRequestBody(null)).toEqual({});
    expect(gatewayRequestBody({ ...gateway(), enabled: false, fallbackModels: ["a"] })).toEqual({});
  });

  it("substitutes no key when no gateway credential exists", () => {
    expect(resolveGatewayAuthKey({ gateway: gateway({ virtualKeysEnabled: true }), business: null })).toBeUndefined();
  });
});

describe("model resolution", () => {
  it("keeps the platform model when the gateway sets no alias", () => {
    expect(resolveChatModel({ platformModel: "gpt-4o-mini", gateway: gateway(), business: null })).toBe(
      "gpt-4o-mini",
    );
  });

  it("prefers the gateway alias over the platform model", () => {
    expect(
      resolveChatModel({ platformModel: "gpt-4o-mini", gateway: gateway({ chatModel: "pos-chat" }), business: null }),
    ).toBe("pos-chat");
  });

  it("ignores a business override while model choice is switched off", () => {
    const result = resolveChatModel({
      platformModel: "gpt-4o-mini",
      gateway: gateway({ chatModel: "pos-chat", allowBusinessModels: false, publishedModels: ["pos-fast"] }),
      business: business({ modelOverride: "pos-fast" }),
    });
    expect(result).toBe("pos-chat");
  });

  it("honours a business override only when it is published", () => {
    const allowed = gateway({
      chatModel: "pos-chat",
      allowBusinessModels: true,
      publishedModels: ["pos-fast", "pos-smart"],
    });
    expect(
      resolveChatModel({
        platformModel: "gpt-4o-mini",
        gateway: allowed,
        business: business({ modelOverride: "pos-smart" }),
      }),
    ).toBe("pos-smart");
  });

  it("refuses an override that is no longer published, even if the row still says it", () => {
    const tightened = gateway({
      chatModel: "pos-chat",
      allowBusinessModels: true,
      publishedModels: ["pos-fast"],
    });
    expect(
      resolveChatModel({
        platformModel: "gpt-4o-mini",
        gateway: tightened,
        business: business({ modelOverride: "pos-smart" }),
      }),
    ).toBe("pos-chat");
  });

  it("falls back from the embedding alias to the chat alias to the platform model", () => {
    expect(
      resolveEmbeddingModel({
        platformModel: "gpt-4o-mini",
        gateway: gateway({ chatModel: "pos-chat", embeddingModel: "" }),
      }),
    ).toBe("pos-chat");
    expect(
      resolveEmbeddingModel({
        platformModel: "gpt-4o-mini",
        gateway: gateway({ chatModel: "", embeddingModel: "" }),
      }),
    ).toBe("gpt-4o-mini");
    expect(
      resolveEmbeddingModel({
        platformModel: "gpt-4o-mini",
        gateway: gateway({ chatModel: "pos-chat", embeddingModel: "pos-embed" }),
      }),
    ).toBe("pos-embed");
  });

  it("returns the plain platform model when there is no gateway", () => {
    expect(resolveEmbeddingModel({ platformModel: "gpt-4o-mini", gateway: null })).toBe("gpt-4o-mini");
  });
});

describe("credential resolution", () => {
  it("prefers the business virtual key when virtual keys are on", () => {
    const key = resolveGatewayAuthKey({
      gateway: gateway({ virtualKeysEnabled: true, masterKey: "sk-master" }),
      business: business({ virtualKey: "sk-tenant" }),
    });
    expect(key).toBe("sk-tenant");
  });

  it("falls back to the master key when the business has no key yet", () => {
    expect(
      resolveGatewayAuthKey({ gateway: gateway({ virtualKeysEnabled: true, masterKey: "sk-master" }), business: null }),
    ).toBe("sk-master");
  });

  it("uses the master key when virtual keys are off", () => {
    const key = resolveGatewayAuthKey({
      gateway: gateway({ virtualKeysEnabled: false, masterKey: "sk-master" }),
      business: business({ virtualKey: "sk-tenant" }),
    });
    expect(key).toBe("sk-master");
  });
});

describe("request body", () => {
  it("attaches the failover chain in order", () => {
    expect(gatewayRequestBody(gateway({ fallbackModels: ["pos-cheap", "pos-last"] }))).toEqual({
      fallbacks: ["pos-cheap", "pos-last"],
    });
  });

  it("omits the field entirely when the chain is empty", () => {
    expect(gatewayRequestBody(gateway({ fallbackModels: [] }))).toEqual({});
  });

  it("includes the model and key in the built runtime", () => {
    const runtime = buildGatewayRuntime({
      config: platform,
      gateway: gateway({ chatModel: "pos-chat", masterKey: "sk-master", fallbackModels: ["pos-cheap"] }),
      business: null,
    });
    expect(runtime).toEqual({
      model: "pos-chat",
      embeddingModel: "pos-chat",
      authKey: "sk-master",
      body: { fallbacks: ["pos-cheap"] },
    });
  });
});

describe("key scoping", () => {
  it("allows the resolved model plus every fallback", () => {
    expect(
      keyModelsFor({
        platformModel: "gpt-4o-mini",
        gateway: gateway({ chatModel: "pos-chat", fallbackModels: ["pos-cheap"], embeddingModel: "pos-embed" }),
        business: null,
      }),
    ).toEqual(["pos-chat", "pos-cheap", "pos-embed"]);
  });

  it("uses the business's own override when it is the model that will be called", () => {
    expect(
      keyModelsFor({
        platformModel: "gpt-4o-mini",
        gateway: gateway({
          allowBusinessModels: true,
          publishedModels: ["pos-fast"],
          fallbackModels: ["pos-cheap"],
        }),
        business: business({ modelOverride: "pos-fast" }),
      }),
    ).toEqual(["pos-fast", "pos-cheap"]);
  });

  it("derives a stable alias from the business id", () => {
    expect(virtualKeyAlias("3f2a-9c")).toBe("pos-3f2a9c");
    expect(virtualKeyAlias("3f2a-9c")).toBe(virtualKeyAlias("3f2a-9c"));
  });
});

describe("management endpoints", () => {
  it("strips the /v1 suffix so management routes resolve", () => {
    expect(gatewayManagementUrl("http://litellm:4000/v1")).toBe("http://litellm:4000");
    expect(gatewayManagementUrl("http://litellm:4000/v1/")).toBe("http://litellm:4000");
    expect(gatewayManagementUrl("http://litellm:4000")).toBe("http://litellm:4000");
  });

  it("builds the endpoints the console calls", () => {
    expect(livelinessUrl("http://litellm:4000/v1")).toBe("http://litellm:4000/health/liveliness");
    expect(modelInfoUrl("http://litellm:4000/v1")).toBe("http://litellm:4000/model/info");
    expect(keyInfoUrl("http://litellm:4000/v1", "sk-a b")).toBe("http://litellm:4000/key/info?key=sk-a%20b");
  });
});

describe("response parsing", () => {
  it("reads model names from /model/info and de-duplicates them", () => {
    expect(
      parseGatewayModels({
        data: [{ model_name: "pos-chat" }, { model_name: "pos-cheap" }, { id: "pos-chat" }, {}],
      }),
    ).toEqual(["pos-chat", "pos-cheap"]);
  });

  it("returns no models rather than throwing on an unrecognised shape", () => {
    expect(parseGatewayModels(null)).toEqual([]);
    expect(parseGatewayModels({ data: "nope" })).toEqual([]);
    expect(parseGatewayModels({})).toEqual([]);
  });

  it("reads the generated key from either field LiteLLM has used", () => {
    expect(parseGeneratedKey({ key: "sk-new" })).toBe("sk-new");
    expect(parseGeneratedKey({ token: "sk-legacy" })).toBe("sk-legacy");
    expect(parseGeneratedKey({})).toBeNull();
    expect(parseGeneratedKey(null)).toBeNull();
  });

  it("reads spend from the nested info block, and from a flat body too", () => {
    expect(parseKeySpend({ key: "sk-1", info: { spend: 1.25, max_budget: 50 } })).toEqual({
      spendUsd: 1.25,
      maxBudgetUsd: 50,
    });
    expect(parseKeySpend({ spend: 0.5, max_budget: null })).toEqual({ spendUsd: 0.5, maxBudgetUsd: null });
    expect(parseKeySpend({ info: {} })).toBeNull();
    expect(parseKeySpend(null)).toBeNull();
  });

  it("maps statuses onto operator-readable messages", () => {
    expect(gatewayStatusMessage(401)).toContain("کلید مدیر");
    expect(gatewayStatusMessage(404)).toContain("یافت نشد");
    expect(gatewayStatusMessage(500)).toContain("خطای داخلی");
    expect(gatewayStatusMessage(418)).toContain("418");
  });
});

describe("list coercion", () => {
  it("accepts arrays, newline text and comma text", () => {
    expect(toStringList(["a", " b ", ""])).toEqual(["a", "b"]);
    expect(toStringList("a\nb,, c")).toEqual(["a", "b", "c"]);
    expect(toStringList(undefined)).toEqual([]);
  });

  it("round-trips through the console textarea", () => {
    expect(toStringList(toListText(["a", "b"]))).toEqual(["a", "b"]);
  });
});

describe("validation", () => {
  it("rejects a base URL that is not a URL", () => {
    expect(validateGatewayInput({ baseUrl: "litellm:4000" })).toContain("ai_gateway_bad_base_url");
    expect(validateGatewayInput({ baseUrl: "http://litellm:4000/v1" })).not.toContain("ai_gateway_bad_base_url");
  });

  it("rejects a routing strategy the proxy does not implement", () => {
    expect(validateGatewayInput({ routingStrategy: "round-robin" })).toContain("ai_gateway_bad_routing");
    expect(validateGatewayInput({ routingStrategy: "least-busy" })).not.toContain("ai_gateway_bad_routing");
  });

  it("rejects non-positive budgets and rate limits", () => {
    const base = { baseUrl: "http://litellm:4000/v1" };
    expect(validateGatewayInput({ ...base, defaultMaxBudgetUsd: 0 })).toContain("ai_gateway_bad_budget");
    expect(validateGatewayInput({ ...base, defaultTpmLimit: -1 })).toContain("ai_gateway_bad_tpm");
    expect(validateGatewayInput({ ...base, defaultRpmLimit: 1.5 })).toContain("ai_gateway_bad_rpm");
    expect(validateGatewayInput({ ...base, defaultMaxBudgetUsd: null, defaultTpmLimit: null })).toEqual([]);
  });

  it("constrains budget durations to a number plus a known unit", () => {
    expect(isValidBudgetDuration("30d")).toBe(true);
    expect(isValidBudgetDuration("12h")).toBe(true);
    expect(isValidBudgetDuration("1mo")).toBe(true);
    expect(isValidBudgetDuration("forever")).toBe(false);
    expect(isValidBudgetDuration("")).toBe(false);
    expect(isValidBudgetDuration(null)).toBe(true);
  });

  it("refuses a model override the platform has not published", () => {
    expect(
      validateBusinessGatewayInput({ modelOverride: "gpt-4o" }, { allowBusinessModels: true, allowedModels: ["pos-fast"] }),
    ).toContain("ai_gateway_model_not_published");
    expect(
      validateBusinessGatewayInput({ modelOverride: null }, { allowBusinessModels: true, allowedModels: ["pos-fast"] }),
    ).toEqual([]);
  });

  it("refuses any override at all when the platform switched the choice off", () => {
    expect(
      validateBusinessGatewayInput(
        { modelOverride: "pos-fast" },
        { allowBusinessModels: false, allowedModels: ["pos-fast"] },
      ),
    ).toContain("ai_gateway_model_choice_disabled");
  });
});

describe("normalising a business patch", () => {
  it("blanks empty strings and drops non-positive limits", () => {
    const row = normaliseBusinessGatewayInput("b1", {
      modelOverride: "  ",
      maxBudgetUsd: 0,
      tpmLimit: 900,
      rpmLimit: null,
    });
    expect(row.modelOverride).toBeNull();
    expect(row.maxBudgetUsd).toBeNull();
    expect(row.tpmLimit).toBe(900);
    expect(row.rpmLimit).toBeNull();
    expect(row.virtualKey).toBeNull();
    expect(row.spendUsd).toBe(0);
  });
});

describe("public shapes never leak credentials", () => {
  it("replaces the master key with a boolean", () => {
    const pub = toPublicGatewayConfig(gateway({ masterKey: "sk-secret" }));
    expect(pub.hasMasterKey).toBe(true);
    expect(JSON.stringify(pub)).not.toContain("sk-secret");
  });

  it("reports a missing master key as false rather than omitting the field", () => {
    expect(toPublicGatewayConfig(gateway({ masterKey: "" })).hasMasterKey).toBe(false);
  });
});
