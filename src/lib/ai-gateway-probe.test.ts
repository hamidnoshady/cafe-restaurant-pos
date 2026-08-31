/**
 * The probe's gateway half, against a stubbed proxy.
 *
 * `probeGateway` is the console's only view of what the gateway is actually
 * doing, so what matters is that it reports the proxy's own answers rather than
 * an echo of the stored settings: the aliases the proxy serves, and the routing
 * strategy the proxy is running — including the case where the two disagree,
 * which is the whole reason the check exists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeGateway } from "./ai-gateway-service";
import { defaultGatewayConfig, type AiGatewayConfig } from "./ai-gateway";

const CONFIG: AiGatewayConfig = {
  ...defaultGatewayConfig(),
  enabled: true,
  baseUrl: "http://litellm:4000/v1",
  masterKey: "sk-master",
  chatModel: "pos-chat",
  embeddingModel: "pos-embed",
  fallbackModels: ["pos-cheap"],
  routingStrategy: "simple-shuffle",
};

type Stub = { status: number; body: unknown };

function stubProxy(routes: Record<string, Stub>) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = String(input);
      urls.push(url);
      const match = Object.entries(routes).find(([path]) => url.endsWith(path));
      const answer = match?.[1] ?? { status: 404, body: { error: "not found" } };
      return {
        status: answer.status,
        text: async () => (answer.body === null ? "" : JSON.stringify(answer.body)),
      } as Response;
    }),
  );
  return urls;
}

const ROUTER_SETTINGS = {
  current_values: {
    routing_strategy: "latency-based-routing",
    fallbacks: [{ "pos-chat": ["pos-cheap"] }],
  },
  fields: [
    { field_name: "routing_strategy", field_value: "latency-based-routing", options: ["simple-shuffle"] },
  ],
};

const MODEL_INFO = {
  data: [
    { model_name: "pos-chat" },
    { model_name: "pos-cheap" },
    { model_name: "pos-embed" },
  ],
};

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the probe", () => {
  it("reads the strategy the proxy is running and flags a disagreement", async () => {
    const urls = stubProxy({
      "/health/liveliness": { status: 200, body: "I'm alive!" },
      "/model/info": { status: 200, body: MODEL_INFO },
      "/router/settings": { status: 200, body: ROUTER_SETTINGS },
    });

    const probe = await probeGateway(CONFIG);

    expect(probe.ok).toBe(true);
    expect(probe.models).toEqual(["pos-chat", "pos-cheap", "pos-embed"]);
    expect(probe.proxyRoutingStrategy).toBe("latency-based-routing");
    expect(probe.routingMismatch).toBe(true);
    // The management root, not the /v1 data plane.
    expect(urls).toContain("http://litellm:4000/router/settings");
  });

  it("reports no mismatch when the proxy runs what is stored", async () => {
    stubProxy({
      "/health/liveliness": { status: 200, body: "I'm alive!" },
      "/model/info": { status: 200, body: MODEL_INFO },
      "/router/settings": {
        status: 200,
        body: { ...ROUTER_SETTINGS, current_values: { routing_strategy: "simple-shuffle" } },
      },
    });

    const probe = await probeGateway(CONFIG);

    expect(probe.proxyRoutingStrategy).toBe("simple-shuffle");
    expect(probe.routingMismatch).toBe(false);
  });

  it("treats a proxy that does not answer as unreadable, not as a fault", async () => {
    stubProxy({
      "/health/liveliness": { status: 200, body: "I'm alive!" },
      "/model/info": { status: 200, body: MODEL_INFO },
      // No /router/settings route: an older proxy build answers 404.
    });

    const probe = await probeGateway(CONFIG);

    expect(probe.ok).toBe(true);
    expect(probe.proxyRoutingStrategy).toBeNull();
    expect(probe.routingMismatch).toBe(false);
  });

  it("never asks the proxy for router settings without an admin key", async () => {
    const urls = stubProxy({
      "/health/liveliness": { status: 200, body: "I'm alive!" },
    });

    const probe = await probeGateway({ ...CONFIG, masterKey: "" });

    expect(probe.ok).toBe(true);
    expect(probe.proxyRoutingStrategy).toBeNull();
    expect(probe.routingMismatch).toBe(false);
    expect(urls.some((url) => url.includes("/router/settings"))).toBe(false);
  });

  it("reports a failure without inventing a routing strategy", async () => {
    stubProxy({});

    const probe = await probeGateway(CONFIG);

    expect(probe.ok).toBe(false);
    expect(probe.proxyRoutingStrategy).toBeNull();
    expect(probe.routingMismatch).toBe(false);
    expect(probe.error).toBeTruthy();
  });
});
