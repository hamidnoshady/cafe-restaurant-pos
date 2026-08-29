/**
 * Phase 37 — the gateway half of the AI connection, kept free of the network,
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
 * The one thing this module deliberately does NOT do is money. LiteLLM's
 * budgets are USD and are enforced by the gateway as a backstop; the amount a
 * business actually owes has always been the integer-Rial ledger in Phase 18
 * and stays there. `spendUsd` below is a diagnostic to reconcile the two.
 */

import type { AiConfig } from "./ai";

// ---------------------------------------------------------------------------
// Configuration shapes
// ---------------------------------------------------------------------------

/** The routing strategies the LiteLLM proxy actually implements. */
export const GATEWAY_ROUTING_STRATEGIES = [
  "simple-shuffle",
  "least-busy",
  "usage-based-router",
  "latency-based-routing",
  "cost-based-routing",
] as const;

export type GatewayRoutingStrategy = (typeof GATEWAY_ROUTING_STRATEGIES)[number];

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
  /** Mint and use one virtual key per business. */
  virtualKeysEnabled: boolean;
  /** Whether a business owner may choose a model, and from which list. */
  allowBusinessModels: boolean;
  publishedModels: string[];
  defaultMaxBudgetUsd: number | null;
  defaultBudgetDuration: string;
  defaultTpmLimit: number | null;
  defaultRpmLimit: number | null;
}

/** Gateway config with the master key replaced by a boolean, as `platform_ai_config` does. */
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
}

/** One business's slice of the gateway: its key, its ceilings, its model choice. */
export interface BusinessGateway {
  businessId: string;
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
  };
}

export function emptyBusinessGateway(businessId: string): BusinessGateway {
  return {
    businessId,
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
//
// The chat/embeddings calls keep using `platform_ai_config.base_url` unchanged
// (it already ends in /v1); the *management* API lives one level up, which is
// why these are derived rather than stored.
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
//
// Every parser fails soft: a gateway is an optional component, and a shape we
// do not recognise must degrade to "no information", never throw into a
// request path that was working before the gateway existed.
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

/** `/key/generate` answers `{ key: "sk-…", … }`; older builds used `token`. */
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
// Per-call resolution
// ---------------------------------------------------------------------------

/**
 * The chat model for one call.
 *
 * Precedence is deliberately narrow: a business may override only when the
 * platform has switched overrides on AND the value is one the platform
 * published. The second half is enforced here as well as on write, because a
 * row written before the allowlist was tightened must not keep reaching a
 * model the platform no longer sells.
 */
export function resolveChatModel(input: {
  platformModel: string;
  gateway: AiGatewayConfig | null;
  business: BusinessGateway | null;
}): string {
  const { platformModel, gateway, business } = input;
  if (!gateway || !gateway.enabled) return platformModel;
  const published = gateway.publishedModels;
  const override = trimmed(business?.modelOverride);
  if (gateway.allowBusinessModels && override && published.includes(override)) return override;
  const alias = trimmed(gateway.chatModel);
  return alias || platformModel;
}

/**
 * The embedding model for one call. Falls through to the chat model, which is
 * what `ai-embeddings.ts` already does today: separating the two is a gateway
 * capability (one alias may route embeddings to a different vendor than chat),
 * not something a direct single-vendor connection can express.
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
 *
 * A virtual key is preferred whenever one exists: it is the only way the
 * gateway can attribute spend, enforce a budget or rate-limit per business
 * rather than for the whole deployment. Falls back to the master key, then to
 * no override at all — in which case the caller's own `apiKey` stands, so a
 * gateway with no master key configured still works if the proxy runs open.
 */
export function resolveGatewayAuthKey(input: {
  gateway: AiGatewayConfig | null;
  business: BusinessGateway | null;
}): string | undefined {
  const { gateway, business } = input;
  if (!gateway || !gateway.enabled) return undefined;
  if (gateway.virtualKeysEnabled && trimmed(business?.virtualKey)) return trimmed(business?.virtualKey);
  if (trimmed(gateway.masterKey)) return trimmed(gateway.masterKey);
  return undefined;
}

/**
 * Extra top-level request fields for one call — LiteLLM's client-side
 * `fallbacks` chain. Empty when there is no gateway, so a direct vendor never
 * receives a field it would reject.
 */
export function gatewayRequestBody(gateway: AiGatewayConfig | null): Record<string, unknown> {
  if (!gateway || !gateway.enabled || gateway.fallbackModels.length === 0) return {};
  return { fallbacks: [...gateway.fallbackModels] };
}

/** The models a virtual key is allowed to call: the alias plus its fallbacks. */
export function keyModelsFor(input: {
  platformModel: string;
  gateway: AiGatewayConfig;
  business: BusinessGateway | null;
}): string[] {
  const primary = resolveChatModel({
    platformModel: input.platformModel,
    gateway: input.gateway,
    business: input.business,
  });
  const models = [primary, ...input.gateway.fallbackModels];
  const embedding = trimmed(input.gateway.embeddingModel);
  if (embedding) models.push(embedding);
  return [...new Set(models.filter((model) => model.length > 0))];
}

/**
 * The address management calls go to.
 *
 * There is deliberately only ONE address in a gateway deployment, and it is
 * the provider connection's: when the platform's provider *is* the gateway,
 * `platform_ai_config.base_url` is already the gateway's `/v1` endpoint, so a
 * second stored address could only ever drift from it — chat would go to one
 * host while keys were minted on another. The gateway row's own address is
 * used only when the provider is something else (i.e. the gateway features are
 * configured ahead of switching the connection over).
 */
export function resolveGatewayBaseUrl(input: {
  platformBaseUrl: string;
  providerIsGateway: boolean;
  gatewayBaseUrl: string;
}): string {
  const platform = trimmed(input.platformBaseUrl);
  if (input.providerIsGateway && platform) return platform;
  return trimmed(input.gatewayBaseUrl) || platform || DEFAULT_GATEWAY_BASE_URL;
}

/** LiteLLM `key_alias` for a business — stable, short and traceable back to the row. */
export function virtualKeyAlias(businessId: string): string {
  return `pos-${businessId.replace(/-/g, "").slice(0, 20)}`;
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
  if (
    input.routingStrategy !== undefined &&
    !GATEWAY_ROUTING_STRATEGIES.includes(input.routingStrategy as GatewayRoutingStrategy)
  ) {
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
  return errors;
}

/**
 * LiteLLM's budget duration is a free-text window (`30d`, `12h`, `1mo`).
 * Constrain it to digits plus a known unit: it reaches the gateway verbatim,
 * and an arbitrary string is at best a rejected write and at worst a
 * nonsensical budget window nobody can reason about later.
 */
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

/**
 * Validate one business's gateway settings.
 *
 * `allowedModels` is the platform's published list; an override outside it is
 * refused here so the check exists in one place and holds for both the
 * platform console and the business's own settings page.
 */
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

/** Coerce a validated business-gateway patch into the row's own shape. */
export function normaliseBusinessGatewayInput(
  businessId: string,
  input: BusinessGatewayInput,
): BusinessGateway {
  const base = emptyBusinessGateway(businessId);
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

/**
 * Whether a gateway is actually serving this configuration — the test the
 * runtime uses before it attaches any gateway fields to a call. A gateway row
 * that exists but is switched off must behave exactly as if it were absent.
 */
export function isGatewayActive(gateway: AiGatewayConfig | null | undefined): boolean {
  return Boolean(gateway?.enabled) && Boolean(trimmed(gateway?.baseUrl));
}

/**
 * Build the `AiConfig.gateway` runtime for one call. Returns undefined — not
 * an empty object — when there is nothing gateway-specific to send, so the
 * common single-vendor deployment keeps a byte-identical request body.
 */
export function buildGatewayRuntime(input: {
  config: AiConfig;
  gateway: AiGatewayConfig | null;
  business: BusinessGateway | null;
}): { model: string; embeddingModel: string; authKey?: string; body: Record<string, unknown> } | undefined {
  if (!isGatewayActive(input.gateway)) return undefined;
  return {
    model: resolveChatModel({
      platformModel: input.config.model,
      gateway: input.gateway,
      business: input.business,
    }),
    embeddingModel: resolveEmbeddingModel({
      platformModel: input.config.model,
      gateway: input.gateway,
    }),
    ...(() => {
      const key = resolveGatewayAuthKey({ gateway: input.gateway, business: input.business });
      return key ? { authKey: key } : {};
    })(),
    body: gatewayRequestBody(input.gateway),
  };
}
