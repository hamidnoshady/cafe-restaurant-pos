/**
 * Phase 37 & Phase 39 — the gateway half of the AI connection, kept free of the network,
 * the database and `next/*`.
 *
 * A gateway (LiteLLM) fronts many upstream vendors behind one OpenAI-shaped
 * endpoint, so the provider client in ai-service.ts never needs to learn that
 * one exists. What it *does* need is a handful of decisions made before the
 * request goes out — which credential to send, which model alias to ask for,
 * whether to attach a failover chain — and every one of those is a pure
 * function of configuration, so they live here where they can be tested
 * without a proxy, a socket or a Postgres (see ai-gateway.test.ts).
 *
 * Phase 39 introduces branch-level overrides:
 * Model resolution: branch override -> business override -> gateway alias -> platform default.
 * Virtual key resolution: branch key -> business key -> gateway master key -> none.
 */

import type { AiConfig } from "./ai";

// ---------------------------------------------------------------------------
// Configuration shapes
// ---------------------------------------------------------------------------

/**
 * The routing strategies the LiteLLM proxy actually implements, in the order
 * the console should offer them.
 *
 * This list is a mirror of the proxy's own vocabulary — the `RoutingStrategy`
 * enum in `litellm/types/router.py` plus `simple-shuffle`, which is the default
 * and is offered by the proxy's `GET /router/settings` as an option. A value
 * that is not in that vocabulary is silently ignored by the proxy, which is
 * worse than a rejected one, so the console must not be able to offer it.
 *
 * Two of these are documented as unsuitable for production and are marked as
 * such in the console: `usage-based-routing` is deprecated (its v2 replacement
 * tracks usage asynchronously), and both usage-based strategies add a Redis
 * round-trip per request.
 */
export const GATEWAY_ROUTING_STRATEGIES = [
  "simple-shuffle",
  "least-busy",
  "latency-based-routing",
  "cost-based-routing",
  "usage-based-routing-v2",
  "usage-based-routing",
  "provider-budget-routing",
] as const;

export type GatewayRoutingStrategy = (typeof GATEWAY_ROUTING_STRATEGIES)[number];

/**
 * Names earlier revisions of this console stored that the proxy never
 * understood. `usage-based-router` was never a LiteLLM value; the strategy it
 * was reaching for is `usage-based-routing-v2`.
 */
const LEGACY_ROUTING_STRATEGIES: Record<string, GatewayRoutingStrategy> = {
  "usage-based-router": "usage-based-routing-v2",
};

/**
 * Fold a stored or posted strategy onto the proxy's vocabulary.
 * Returns `null` for anything the proxy would ignore, so callers can reject it
 * instead of storing a value that would quietly do nothing.
 */
export function normaliseRoutingStrategy(value: unknown): GatewayRoutingStrategy | null {
  const text = trimmed(value).toLowerCase();
  if (!text) return null;
  if ((GATEWAY_ROUTING_STRATEGIES as readonly string[]).includes(text)) {
    return text as GatewayRoutingStrategy;
  }
  return LEGACY_ROUTING_STRATEGIES[text] ?? null;
}

/** How often a virtual key's budget resets. LiteLLM accepts e.g. "30d", "1mo". */
export const GATEWAY_BUDGET_DURATIONS = ["1d", "7d", "30d", "1mo"] as const;

export interface AiGatewayConfig {
  enabled: boolean;
  baseUrl: string;
  /** The proxy admin key. Server-side only — never serialised to a client. */
  masterKey: string;
  /** Gateway model alias for chat; empty means "use the platform model". */
  chatModel: string;
  /** Gateway model alias for embeddings; empty means "use the chat model". */
  embeddingModel: string;
  /** Failover chain, tried in order after the primary model errors. */
  fallbackModels: string[];
  routingStrategy: GatewayRoutingStrategy;
  /** Mint and use one virtual key per business or branch. */
  virtualKeysEnabled: boolean;
  /** Whether a business owner may choose a model, and from which list. */
  allowBusinessModels: boolean;
  publishedModels: string[];
  defaultMaxBudgetUsd: number | null;
  defaultBudgetDuration: string;
  defaultTpmLimit: number | null;
  defaultRpmLimit: number | null;
  /** Phase 38b — FX rate turning the gateway's USD cost figures into Rial. */
  usdRialRate: number | null;
  /** Phase 38b — settle turns on the gateway's own reported cost. */
  gatewayCostingEnabled: boolean;
  /**
   * Optional extra margin the platform adds on top of LiteLLM's reported cost,
   * in percent. Normally 0: cost-plus-margin pricing is configured inside
   * LiteLLM itself, and the platform only converts and decrements. Kept here
   * so an operator can still add a platform-side markup without touching the
   * gateway config.
   */
  revenueMarginPercent: number;
  /**
   * The Rial ceiling reserved from a business's credit for one assistant turn,
   * released back down to LiteLLM's actual reported cost at settlement.
   */
  maxTurnRial: number;
  /** Phase 38b — whether the proxy may front MCP servers at all. */
  mcpEnabled: boolean;
  /** Phase 38b — the MCP servers the proxy may front (agentic tools). */
  mcpServers: GatewayMcpServer[];
}

/**
 * Gateway config with the master key replaced by a boolean.
 *
 * Only the master key is a bearer credential and stays server-side; the costing
 * fields (conversion rate, margin, ceilings) are operator settings the LiteLLM
 * console must show and edit.
 */
export interface PublicAiGatewayConfig extends Omit<AiGatewayConfig, "masterKey"> {
  hasMasterKey: boolean;
}

export interface AiGatewayInput {
  enabled?: boolean;
  baseUrl?: string;
  masterKey?: string;
  chatModel?: string;
  embeddingModel?: string;
  fallbackModels?: unknown;
  routingStrategy?: string;
  virtualKeysEnabled?: boolean;
  allowBusinessModels?: boolean;
  publishedModels?: unknown;
  defaultMaxBudgetUsd?: number | null;
  defaultBudgetDuration?: string;
  defaultTpmLimit?: number | null;
  defaultRpmLimit?: number | null;
  usdRialRate?: number | null;
  gatewayCostingEnabled?: boolean;
  revenueMarginPercent?: number | null;
  maxTurnRial?: number | null;
  mcpEnabled?: boolean;
  mcpServers?: unknown;
}

/**
 * Phase 38b — one MCP server the LiteLLM proxy fronts.
 */
export interface GatewayMcpServer {
  /** Stable identifier — becomes the proxy's `server_label` and its URL path. */
  name: string;
  /** Persian display name for the console. */
  label: string;
  /** The server's MCP endpoint (streamable HTTP). */
  url: string;
}

/** One business or branch's slice of the gateway: its key, its ceilings, its model choice. */
export interface BusinessGateway {
  id?: string;
  businessId: string;
  locationId: string | null;
  virtualKey: string | null;
  keyAlias: string | null;
  modelOverride: string | null;
  maxBudgetUsd: number | null;
  budgetDuration: string | null;
  tpmLimit: number | null;
  rpmLimit: number | null;
  spendUsd: number;
  syncedAt: string | null;
  syncError: string | null;
}

/** Client-safe shape: the virtual key is a bearer credential and stays server-side. */
export interface PublicBusinessGateway extends Omit<BusinessGateway, "virtualKey"> {
  hasVirtualKey: boolean;
  /** Which model this business's calls actually resolve to, gateway included. */
  effectiveModel: string;
}

export interface GatewayProbe {
  ok: boolean;
  /** Wall-clock milliseconds for the liveliness call. */
  latencyMs: number | null;
  /** Model aliases the gateway is serving, when the admin key allowed listing them. */
  models: string[];
  /**
   * The routing strategy the proxy reports it is running, from its own
   * `/router/settings`. `null` when the proxy did not answer — which is not a
   * mismatch, just an unreadable one.
   */
  proxyRoutingStrategy: string | null;
  /** True when the strategy stored here is not the one the proxy is running. */
  routingMismatch: boolean;
  /** A short, human-readable failure reason — Persian, shown verbatim in the console. */
  error: string | null;
}

// ---------------------------------------------------------------------------
// Defaults and coercion
// ---------------------------------------------------------------------------

export const DEFAULT_GATEWAY_BASE_URL = "http://litellm:4000/v1";

export function defaultGatewayConfig(): AiGatewayConfig {
  return {
    enabled: false,
    baseUrl: DEFAULT_GATEWAY_BASE_URL,
    masterKey: "",
    chatModel: "",
    embeddingModel: "",
    fallbackModels: [],
    routingStrategy: "simple-shuffle",
    virtualKeysEnabled: false,
    allowBusinessModels: false,
    publishedModels: [],
    defaultMaxBudgetUsd: null,
    defaultBudgetDuration: "30d",
    defaultTpmLimit: null,
    defaultRpmLimit: null,
    usdRialRate: null,
    gatewayCostingEnabled: false,
    revenueMarginPercent: 0,
    maxTurnRial: 0,
    mcpEnabled: false,
    mcpServers: [],
  };
}

export function emptyBusinessGateway(businessId: string, locationId: string | null = null): BusinessGateway {
  return {
    businessId,
    locationId,
    virtualKey: null,
    keyAlias: null,
    modelOverride: null,
    maxBudgetUsd: null,
    budgetDuration: null,
    tpmLimit: null,
    rpmLimit: null,
    spendUsd: 0,
    syncedAt: null,
    syncError: null,
  };
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A `jsonb` column arrives as a parsed array; the UI also posts plain strings
 * and comma-separated text. Accept all three so the console never has to know
 * which column produced the value.
 */
export function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => trimmed(entry))
      .filter((entry) => entry.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return [];
}

/** The inverse of `toStringList` for the console textarea. */
export function toListText(values: string[]): string {
  return values.join("\n");
}

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------

/** `name | label | url`, one server per line — the console's MCP editor format. */
export function mcpServersToText(servers: GatewayMcpServer[]): string {
  return servers.map((server) => [server.name, server.label, server.url].join(" | ")).join("\n");
}

/**
 * Normalise the MCP server list.
 */
export function normalizeMcpServers(value: unknown): GatewayMcpServer[] {
  if (!Array.isArray(value)) return [];
  const servers: GatewayMcpServer[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const name = trimmed(row.name).toLowerCase().replace(/[^a-z0-9_-]/g, "");
    const url = trimmed(row.url);
    if (!name || !url || seen.has(name)) continue;
    seen.add(name);
    servers.push({ name, label: trimmed(row.label) || name, url });
  }
  return servers;
}

/** Parse the console's `name | label | url` textarea into server rows. */
export function mcpServersFromText(text: string): GatewayMcpServer[] {
  return normalizeMcpServers(
    text
      .split("\n")
      .map((line) => {
        const [name, label, url] = line.split("|");
        return { name, label, url };
      }),
  );
}

/**
 * The `tools` entries that hand the proxy's MCP servers to one call.
 */
export function gatewayMcpToolsBody(gateway: AiGatewayConfig | null): Record<string, unknown> {
  if (!gateway || !gateway.enabled || !gateway.mcpEnabled || gateway.mcpServers.length === 0) {
    return {};
  }
  return {
    tools: gateway.mcpServers.map((server) => ({
      type: "mcp",
      server_url: `litellm_proxy/${server.name}/mcp`,
      server_label: server.name,
      require_approval: "never",
    })),
  };
}

/**
 * LiteLLM's per-response cost header, in USD.
 */
export function parseResponseCostHeader(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  const cost = Number(value);
  return Number.isFinite(cost) && cost >= 0 ? cost : null;
}

/** The gateway's USD figure in integer Rial, rounded once, never negative. */
export function rialFromGatewayUsd(costUsd: number, usdRialRate: number): number {
  const cost = Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0;
  const rate = Number.isFinite(usdRialRate) && usdRialRate > 0 ? usdRialRate : 0;
  if (cost <= 0 || rate <= 0) return 0;
  return Math.ceil(cost * rate);
}

/**
 * The settlement figures for one turn priced by the gateway.
 */
export function gatewayTurnPricing(
  costUsd: number,
  usdRialRate: number,
  marginPercent: number,
): { costRial: number; chargedRial: number } {
  const costRial = rialFromGatewayUsd(costUsd, usdRialRate);
  if (costRial <= 0) return { costRial: 0, chargedRial: 0 };
  const margin = Number.isFinite(marginPercent) && marginPercent > 0 ? marginPercent : 0;
  const chargedRial = Math.ceil((costRial * (100 + margin)) / 100);
  return { costRial, chargedRial: Math.max(chargedRial, costRial) };
}

function positiveNumberOrNull(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function positiveIntOrNull(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

export function toPublicGatewayConfig(config: AiGatewayConfig): PublicAiGatewayConfig {
  const { masterKey, ...rest } = config;
  return { ...rest, hasMasterKey: masterKey.length > 0 };
}

// ---------------------------------------------------------------------------
// Gateway REST endpoints
// ---------------------------------------------------------------------------

export function gatewayManagementUrl(baseUrl: string): string {
  const root = trimmed(baseUrl).replace(/\/+$/, "");
  return root.endsWith("/v1") ? root.slice(0, -3) : root;
}

export function livelinessUrl(baseUrl: string): string {
  return `${gatewayManagementUrl(baseUrl)}/health/liveliness`;
}

export function modelInfoUrl(baseUrl: string): string {
  return `${gatewayManagementUrl(baseUrl)}/model/info`;
}

/**
 * The proxy's live router configuration — the strategy it is actually running,
 * the fallback chains it declares, and the strategies it offers.
 *
 * Read-only: LiteLLM exposes no endpoint that changes `routing_strategy` at
 * runtime, so this is how the console *verifies* the stored value rather than
 * pushing it. The proxy's own answer always wins over what is stored here.
 */
export function routerSettingsUrl(baseUrl: string): string {
  return `${gatewayManagementUrl(baseUrl)}/router/settings`;
}

export function keyGenerateUrl(baseUrl: string): string {
  return `${gatewayManagementUrl(baseUrl)}/key/generate`;
}

export function keyUpdateUrl(baseUrl: string): string {
  return `${gatewayManagementUrl(baseUrl)}/key/update`;
}

export function keyDeleteUrl(baseUrl: string): string {
  return `${gatewayManagementUrl(baseUrl)}/key/delete`;
}

export function keyInfoUrl(baseUrl: string, key: string): string {
  return `${gatewayManagementUrl(baseUrl)}/key/info?key=${encodeURIComponent(key)}`;
}

// ---------------------------------------------------------------------------
// Parsing gateway responses
// ---------------------------------------------------------------------------

/** `/model/info` returns `{ data: [{ model_name, litellm_params }] }`. */
export function parseGatewayModels(payload: unknown): string[] {
  const row = payload as { data?: unknown } | null;
  const data = row?.data;
  if (!Array.isArray(data)) return [];
  const names = data
    .map((entry) => {
      const item = entry as { model_name?: unknown; id?: unknown };
      if (typeof item.model_name === "string" && item.model_name.trim()) return item.model_name.trim();
      if (typeof item.id === "string" && item.id.trim()) return item.id.trim();
      return "";
    })
    .filter((name) => name.length > 0);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/** One `model_name -> [fallback model_names]` rule the proxy declares. */
export interface ProxyFallbackRule {
  from: string;
  to: string[];
}

/** What the proxy's own router reports, from `GET /router/settings`. */
export interface ProxyRouterSettings {
  /** The strategy the proxy is actually running; `null` when it does not say. */
  routingStrategy: string | null;
  /** The strategies this proxy build offers, when it reports them. */
  routingOptions: string[];
  /** The fallback rules the proxy declares in `router_settings`. */
  fallbacks: ProxyFallbackRule[];
}

const EMPTY_ROUTER_SETTINGS: ProxyRouterSettings = {
  routingStrategy: null,
  routingOptions: [],
  fallbacks: [],
};

/**
 * `/router/settings` answers
 * `{ fields: [{ field_name, field_value, options }], current_values: {…} }`.
 *
 * `current_values` is the authoritative view (the proxy merges the live router
 * with its own config there); `fields[]` carries the same values plus the
 * strategies this build offers. Both are read, because an older proxy may
 * populate only one of them, and an absent value must stay `null` rather than
 * being mistaken for a match.
 */
export function parseRouterSettings(payload: unknown): ProxyRouterSettings {
  const row = payload as {
    current_values?: Record<string, unknown>;
    fields?: unknown;
  } | null;
  if (!row || typeof row !== "object") return { ...EMPTY_ROUTER_SETTINGS };

  const current = row.current_values && typeof row.current_values === "object" ? row.current_values : {};
  const fields = Array.isArray(row.fields) ? (row.fields as Record<string, unknown>[]) : [];
  const field = fields.find((entry) => trimmed(entry?.field_name) === "routing_strategy");

  const fromCurrent = typeof current.routing_strategy === "string" ? current.routing_strategy : "";
  const fromField = field && typeof field.field_value === "string" ? field.field_value : "";
  const routingStrategy = trimmed(fromCurrent) || trimmed(fromField) || null;

  const routingOptions =
    field && Array.isArray(field.options) ? toStringList(field.options) : [];

  // `fallbacks` is `List[Dict[str, List[str]]]` — one entry per model group.
  const rawFallbacks = Array.isArray(current.fallbacks) ? current.fallbacks : [];
  const fallbacks: ProxyFallbackRule[] = [];
  for (const entry of rawFallbacks) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    for (const [from, to] of Object.entries(entry as Record<string, unknown>)) {
      const targets = toStringList(to);
      if (trimmed(from) && targets.length > 0) {
        fallbacks.push({ from: trimmed(from), to: targets });
      }
    }
  }

  return { routingStrategy, routingOptions, fallbacks };
}

/**
 * Whether the console's stored strategy is the one the proxy is running.
 * A proxy that does not report its strategy (`null`) is not a mismatch — the
 * console must not claim a fault it cannot see.
 */
export function routingStrategyMatches(configured: string, proxy: string | null): boolean {
  if (!proxy) return true;
  return normaliseRoutingStrategy(configured) === normaliseRoutingStrategy(proxy);
}

/** `/key/generate` answers `{ key: "sk-…", … }`. */
export function parseGeneratedKey(payload: unknown): string | null {
  const row = payload as Record<string, unknown> | null;
  if (!row) return null;
  for (const field of ["key", "token"]) {
    const value = row[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** `/key/info` answers `{ key, info: { spend, max_budget } }`. */
export function parseKeySpend(payload: unknown): {
  spendUsd: number;
  maxBudgetUsd: number | null;
} | null {
  const row = payload as { info?: unknown } | null;
  const source = (row?.info && typeof row.info === "object" ? row.info : row) as
    | Record<string, unknown>
    | null
    | undefined;
  if (!source) return null;
  const spend = Number(source.spend);
  if (!Number.isFinite(spend)) return null;
  const budget = source.max_budget;
  const budgetNumber = typeof budget === "number" ? budget : Number(budget);
  return {
    spendUsd: spend,
    maxBudgetUsd:
      typeof budgetNumber === "number" && Number.isFinite(budgetNumber) && budgetNumber > 0
        ? budgetNumber
        : null,
  };
}

/** Map a management-API status onto a Persian message shown in the console. */
export function gatewayStatusMessage(status: number): string {
  if (status === 401 || status === 403) return "کلید مدیر دروازه پذیرفته نشد.";
  if (status === 404) return "نشانی دروازه یافت نشد (مسیر مدیریت در دسترس نیست).";
  if (status >= 500) return "دروازه در دسترس است اما خطای داخلی داد.";
  return `دروازه پاسخ نامنتظر داد (${status}).`;
}

// ---------------------------------------------------------------------------
// Per-call resolution with Branch -> Business -> Platform fallback
// ---------------------------------------------------------------------------

/**
 * The chat model for one call.
 * Precedence: Branch override -> Business override -> Gateway alias -> Platform default.
 */
export function resolveChatModel(input: {
  platformModel: string;
  gateway: AiGatewayConfig | null;
  business?: BusinessGateway | null;
  branch?: BusinessGateway | null;
}): string {
  const { platformModel, gateway, business, branch } = input;
  if (!gateway || !gateway.enabled) return platformModel;
  const published = gateway.publishedModels;
  if (gateway.allowBusinessModels) {
    const branchOverride = trimmed(branch?.modelOverride);
    if (branchOverride && published.includes(branchOverride)) return branchOverride;
    const businessOverride = trimmed(business?.modelOverride);
    if (businessOverride && published.includes(businessOverride)) return businessOverride;
  }
  const alias = trimmed(gateway.chatModel);
  return alias || platformModel;
}

/**
 * The embedding model for one call. Falls through to the chat model.
 */
export function resolveEmbeddingModel(input: {
  platformModel: string;
  gateway: AiGatewayConfig | null;
}): string {
  const { platformModel, gateway } = input;
  if (!gateway || !gateway.enabled) return platformModel;
  const alias = trimmed(gateway.embeddingModel);
  return alias || trimmed(gateway.chatModel) || platformModel;
}

/**
 * The credential for one call.
 * Precedence: Branch virtual key -> Business virtual key -> Gateway master key -> undefined.
 */
export function resolveGatewayAuthKey(input: {
  gateway: AiGatewayConfig | null;
  business?: BusinessGateway | null;
  branch?: BusinessGateway | null;
}): string | undefined {
  const { gateway, business, branch } = input;
  if (!gateway || !gateway.enabled) return undefined;
  if (gateway.virtualKeysEnabled) {
    if (trimmed(branch?.virtualKey)) return trimmed(branch?.virtualKey);
    if (trimmed(business?.virtualKey)) return trimmed(business?.virtualKey);
  }
  if (trimmed(gateway.masterKey)) return trimmed(gateway.masterKey);
  return undefined;
}

/**
 * Extra top-level request fields for one call — LiteLLM's client-side `fallbacks` chain.
 */
export function gatewayRequestBody(gateway: AiGatewayConfig | null): Record<string, unknown> {
  if (!gateway || !gateway.enabled || gateway.fallbackModels.length === 0) return {};
  return { fallbacks: [...gateway.fallbackModels] };
}

/** The models a virtual key is allowed to call: the alias plus its fallbacks. */
export function keyModelsFor(input: {
  platformModel: string;
  gateway: AiGatewayConfig;
  business?: BusinessGateway | null;
  branch?: BusinessGateway | null;
}): string[] {
  const primary = resolveChatModel({
    platformModel: input.platformModel,
    gateway: input.gateway,
    business: input.business,
    branch: input.branch,
  });
  const models = [primary, ...input.gateway.fallbackModels];
  const embedding = trimmed(input.gateway.embeddingModel);
  if (embedding) models.push(embedding);
  return [...new Set(models.filter((model) => model.length > 0))];
}

/** LiteLLM `key_alias` for a business or branch — stable, short and traceable. */
export function virtualKeyAlias(businessId: string, locationId?: string | null): string {
  const b = businessId.replace(/-/g, "").slice(0, 16);
  if (locationId) {
    const loc = locationId.replace(/-/g, "").slice(0, 8);
    return `pos-${b}-${loc}`;
  }
  return `pos-${b}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateGatewayInput(input: AiGatewayInput): string[] {
  const errors: string[] = [];
  const base = trimmed(input.baseUrl);
  if (!/^https?:\/\/.+/i.test(base)) errors.push("ai_gateway_bad_base_url");

  if (input.fallbackModels !== undefined && !Array.isArray(input.fallbackModels)) {
    errors.push("ai_gateway_bad_fallbacks");
  }
  if (input.publishedModels !== undefined && !Array.isArray(input.publishedModels)) {
    errors.push("ai_gateway_bad_published_models");
  }
  if (input.routingStrategy !== undefined && normaliseRoutingStrategy(input.routingStrategy) === null) {
    errors.push("ai_gateway_bad_routing");
  }
  if (input.defaultBudgetDuration !== undefined && !trimmed(input.defaultBudgetDuration)) {
    errors.push("ai_gateway_bad_duration");
  }
  if (!isValidBudgetDuration(input.defaultBudgetDuration)) {
    errors.push("ai_gateway_bad_duration");
  }
  if (
    input.defaultMaxBudgetUsd !== undefined &&
    input.defaultMaxBudgetUsd !== null &&
    !(Number.isFinite(input.defaultMaxBudgetUsd) && input.defaultMaxBudgetUsd > 0)
  ) {
    errors.push("ai_gateway_bad_budget");
  }
  if (
    input.defaultTpmLimit !== undefined &&
    input.defaultTpmLimit !== null &&
    !(Number.isSafeInteger(input.defaultTpmLimit) && input.defaultTpmLimit > 0)
  ) {
    errors.push("ai_gateway_bad_tpm");
  }
  if (
    input.defaultRpmLimit !== undefined &&
    input.defaultRpmLimit !== null &&
    !(Number.isSafeInteger(input.defaultRpmLimit) && input.defaultRpmLimit > 0)
  ) {
    errors.push("ai_gateway_bad_rpm");
  }
  if (
    input.usdRialRate !== undefined &&
    input.usdRialRate !== null &&
    !(Number.isFinite(input.usdRialRate) && input.usdRialRate > 0)
  ) {
    errors.push("ai_gateway_bad_usd_rate");
  }
  if (input.gatewayCostingEnabled && !(Number(input.usdRialRate) > 0)) {
    errors.push("ai_gateway_costing_needs_rate");
  }
  if (
    input.revenueMarginPercent !== undefined &&
    input.revenueMarginPercent !== null &&
    !(Number.isFinite(input.revenueMarginPercent) && input.revenueMarginPercent >= 0)
  ) {
    errors.push("ai_gateway_bad_margin");
  }
  if (
    input.maxTurnRial !== undefined &&
    input.maxTurnRial !== null &&
    !(Number.isFinite(input.maxTurnRial) && input.maxTurnRial >= 0)
  ) {
    errors.push("ai_gateway_bad_max_turn");
  }
  if (input.mcpServers !== undefined && !Array.isArray(input.mcpServers)) {
    errors.push("ai_gateway_bad_mcp_servers");
  }
  return errors;
}

export function isValidBudgetDuration(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  const text = trimmed(value);
  if (!text) return false;
  return /^\d+\s*(s|m|h|d|mo)$/i.test(text);
}

export interface BusinessGatewayInput {
  modelOverride?: string | null;
  maxBudgetUsd?: number | null;
  budgetDuration?: string | null;
  tpmLimit?: number | null;
  rpmLimit?: number | null;
}

export function validateBusinessGatewayInput(
  input: BusinessGatewayInput,
  options: { allowBusinessModels: boolean; allowedModels: string[] },
): string[] {
  const errors: string[] = [];
  if (input.modelOverride !== undefined && input.modelOverride !== null) {
    const model = trimmed(input.modelOverride);
    if (model && !options.allowBusinessModels) {
      errors.push("ai_gateway_model_choice_disabled");
    } else if (model && !options.allowedModels.includes(model)) {
      errors.push("ai_gateway_model_not_published");
    }
  }
  if (input.maxBudgetUsd !== undefined && input.maxBudgetUsd !== null) {
    const budget = positiveNumberOrNull(input.maxBudgetUsd);
    if (!budget) errors.push("ai_gateway_bad_budget");
  }
  if (input.budgetDuration !== undefined && input.budgetDuration !== null) {
    if (!isValidBudgetDuration(input.budgetDuration)) errors.push("ai_gateway_bad_duration");
  }
  if (input.tpmLimit !== undefined && input.tpmLimit !== null && !positiveIntOrNull(input.tpmLimit)) {
    errors.push("ai_gateway_bad_tpm");
  }
  if (input.rpmLimit !== undefined && input.rpmLimit !== null && !positiveIntOrNull(input.rpmLimit)) {
    errors.push("ai_gateway_bad_rpm");
  }
  return errors;
}

export function normaliseBusinessGatewayInput(
  businessId: string,
  input: BusinessGatewayInput,
  locationId: string | null = null,
): BusinessGateway {
  const base = emptyBusinessGateway(businessId, locationId);
  return {
    ...base,
    modelOverride: input.modelOverride === undefined ? base.modelOverride : trimmed(input.modelOverride) || null,
    maxBudgetUsd: input.maxBudgetUsd === undefined ? base.maxBudgetUsd : positiveNumberOrNull(input.maxBudgetUsd),
    budgetDuration:
      input.budgetDuration === undefined ? base.budgetDuration : trimmed(input.budgetDuration) || null,
    tpmLimit: input.tpmLimit === undefined ? base.tpmLimit : positiveIntOrNull(input.tpmLimit),
    rpmLimit: input.rpmLimit === undefined ? base.rpmLimit : positiveIntOrNull(input.rpmLimit),
  };
}

export function isGatewayActive(gateway: AiGatewayConfig | null | undefined): boolean {
  return Boolean(gateway?.enabled) && Boolean(trimmed(gateway?.baseUrl));
}

export function buildGatewayRuntime(input: {
  config: AiConfig;
  gateway: AiGatewayConfig | null;
  business?: BusinessGateway | null;
  branch?: BusinessGateway | null;
}): {
  model: string;
  embeddingModel: string;
  authKey?: string;
  body: Record<string, unknown>;
} | undefined {
  if (!input.gateway || !isGatewayActive(input.gateway)) return undefined;
  const gateway = input.gateway;
  const mcpBody = gatewayMcpToolsBody(gateway);
  const body = {
    ...gatewayRequestBody(gateway),
    ...mcpBody,
  };
  return {
    model: resolveChatModel({
      platformModel: input.config.model,
      gateway,
      business: input.business,
      branch: input.branch,
    }),
    embeddingModel: resolveEmbeddingModel({
      platformModel: input.config.model,
      gateway,
    }),
    ...(() => {
      const key = resolveGatewayAuthKey({ gateway, business: input.business, branch: input.branch });
      return key ? { authKey: key } : {};
    })(),
    body,
  };
}
